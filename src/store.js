'use strict';
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
// Правила запуска (этап C3) живут в src/runlangs.js — одном на main и renderer
const { sanitizeRunConfig } = require('./runlangs');

const DEFAULTS = () => ({
  version: 1, projects: [], sessions: {}, lastProjectId: null,
  // layoutRatio — наследие прежней раскладки (долю ширины чата считал main).
  // Поле больше не используется, но и не удаляется: чужие данные из config.json не выбрасываем.
  layoutRatio: 0.5,
  // Этап B (ТЗ §5, §28): ширины панелей в px и сторона чата. Геометрию считает renderer
  // (ui/layout.js), main только хранит последнее сохранённое значение. null — первый запуск.
  layout: null,
  // Запуск (этап C3, ТЗ §3.9): инструменты языков, доп. аргументы, таймаут бездействия.
  // tools: null = автопоиск в PATH, строка = абсолютный путь к исполняемому файлу.
  // shellWin зафиксирован на 'cmd': оболочка &CMD: на Windows — только cmd.exe
  // (решение пользователя, PowerShell не внедряем).
  run: sanitizeRunConfig(null),
  promptDraft: null, // текущие поля генератора промптов
  promptPresets: [], // [{id, name, sections}]
  promptTreeOff: {}, // projectId -> [относительные пути, исключённые из структуры]
  proposalDecisions: {}, // chatId -> {contentHash: {status, historyId?, ts}}
  // Журнал контекста (src/context.js). Знание привязано к ЧАТУ, а не к проекту:
  // в одном проекте может быть несколько чатов, и в каждом модель знает своё.
  contextKnown: {}, // chatId -> { "projectId::relPath" -> {hash, source, ts, historyId} }
  contextSeen: {}, // chatId -> [contentHash] — какие блоки ответа модели уже разобраны
});
const HISTORY_LIMIT = 1000;
// Кто инициировал запись файла (ТЗ §10). Без этого история не отличает правку пользователя
// в редакторе от применения предложения модели — а откат и drift-детекция зависят от различия.
const HISTORY_SOURCES = ['ai', 'manual', 'rollback'];
// Сколько записей об откате держим на один файл. Откат неоткатим и резервных копий не
// хранит, поэтому запись — только для журнала; больше двух на файл не нужно.
const ROLLBACK_RECORD_LIMIT = 2;
// Снимки версий для сравнения «что знала модель → что на диске». Ограничения нужны,
// чтобы журнал не превратился в склад копий проекта.
const CONTEXT_SNAPSHOT_MAX_CHARS = 1_000_000; // ~1 МБ текста на версию
const CONTEXT_SNAPSHOT_LIMIT = 300; // всего снимков, лишние — невостребованные и старые
const normalizeSource = (s) => (HISTORY_SOURCES.includes(s) ? s : 'ai');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.configPath = path.join(dir, 'config.json');
    this.historyPath = path.join(dir, 'history.json');
    this.backupDir = path.join(dir, 'backups');
    // Снимки версий, которые видела модель. Адресуются по содержимому (имя файла = sha256),
    // поэтому одинаковый текст двух файлов хранится один раз.
    this.contextDir = path.join(dir, 'context');
    this.config = DEFAULTS();
    this.history = [];
    this._q = Promise.resolve();
  }

  async load() {
    await fs.mkdir(this.backupDir, { recursive: true });
    this.config = { ...DEFAULTS(), ...(await readJson(this.configPath, {})) };
    if (!this.config.contextKnown || typeof this.config.contextKnown !== 'object') this.config.contextKnown = {};
    if (!this.config.contextSeen || typeof this.config.contextSeen !== 'object') this.config.contextSeen = {};
    // layout приводится к допустимому виду там, где живут правила раскладки (ui/layout.js), —
    // здесь только грубая защита от мусора в config.json
    if (this.config.layout !== null && (typeof this.config.layout !== 'object' || Array.isArray(this.config.layout))) this.config.layout = null;
    // config.run — через sanitizeRunConfig: чужой или битый config.json не роняет запуск
    this.config.run = sanitizeRunConfig(this.config.run);
    const h = await readJson(this.historyPath, []);
    // Прежние отметки «модель знает версию» переносим в журнал контекста — и сразу
    // сохраняем, иначе устаревшее поле modelSynced навсегда осталось бы в config.json.
    if (this._migrateModelSynced()) await this.saveConfig();
    // Записи старше Stage 0 не имеют source: до этого поля все изменения приходили из
    // предложений модели, поэтому отсутствующий source честно означает 'ai'.
    this.history = (Array.isArray(h) ? h : []).map((e) => (e && typeof e === 'object'
      ? (HISTORY_SOURCES.includes(e.source) ? e : { ...e, source: 'ai' })
      : e));
  }

  // Записи сериализуются в очередь, запись атомарна (tmp + rename)
  _write(file, data) {
    this._q = this._q
      .then(async () => {
        const tmp = file + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(data, null, 2));
        await fs.rename(tmp, file);
      })
      .catch((e) => console.error('[store] write failed:', e));
    return this._q;
  }
  saveConfig() { return this._write(this.configPath, this.config); }
  saveHistory() { return this._write(this.historyPath, this.history); }

  /**
   * Прежде отметка «модель знает версию» хранилась по проекту (modelSynced). Теперь она
   * относится к чату. Переносим в каждый чат, привязанный к этому проекту: другого
   * адресата из старых данных не вывести, а потерять подтверждение пользователя хуже.
   */
  _migrateModelSynced() {
    const old = this.config.modelSynced;
    if (!old || typeof old !== 'object') return false;
    if (!Object.keys(old).length) { delete this.config.modelSynced; return true; }
    const chatsByProject = {};
    for (const [chatId, sess] of Object.entries(this.config.sessions || {})) {
      if (!sess || !sess.projectId) continue;
      (chatsByProject[sess.projectId] = chatsByProject[sess.projectId] || []).push(chatId);
    }
    for (const [projectId, files] of Object.entries(old)) {
      if (!files || typeof files !== 'object') continue;
      for (const chatId of chatsByProject[projectId] || []) {
        if (!this.config.contextKnown[chatId]) this.config.contextKnown[chatId] = {};
        for (const [relPath, hash] of Object.entries(files)) {
          if (typeof hash !== 'string' || !hash) continue;
          this.config.contextKnown[chatId][projectId + '::' + relPath] = {
            hash, source: 'migrated', ts: Date.now(), historyId: null,
          };
        }
      }
    }
    delete this.config.modelSynced;
    return true;
  }

  // ---- журнал контекста ----
  contextKnown() {
    if (!this.config.contextKnown || typeof this.config.contextKnown !== 'object') this.config.contextKnown = {};
    return this.config.contextKnown;
  }

  contextSeen() {
    if (!this.config.contextSeen || typeof this.config.contextSeen !== 'object') this.config.contextSeen = {};
    return this.config.contextSeen;
  }

  saveContext() { return this.saveConfig(); }

  /**
   * Сохраняет текст версии, которую видела модель, чтобы потом показать сравнение
   * «что знала модель → что на диске». Без снимка журнал знает только хэш, и на любой
   * вопрос «а что именно изменилось» ответить нечем.
   *
   * Храним декодированный текст, а не байты: сравнивать его будем с currentText из
   * readTextFile, то есть в том же виде. Ключ — хэш байтов, он же идентификатор записи
   * журнала, поэтому снимок находится без дополнительных сопоставлений.
   *
   * @returns {Promise<boolean>} false — снимок не сохранён (слишком большой, ошибка ввода-вывода)
   */
  async saveContextSnapshot(hash, text) {
    if (typeof hash !== 'string' || !hash || typeof text !== 'string') return false;
    if (text.length > CONTEXT_SNAPSHOT_MAX_CHARS) return false;
    const file = path.join(this.contextDir, hash);
    try {
      await fs.mkdir(this.contextDir, { recursive: true });
      try {
        await fs.access(file);
        return true; // контент-адресуемый: такой снимок уже есть
      } catch { /* нет — пишем */ }
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, file);
      await this._pruneContextSnapshots();
      return true;
    } catch (e) {
      console.error('[context snapshot]', e.message);
      return false;
    }
  }

  /** @returns {Promise<string|null>} текст версии, которую видела модель, или null */
  async readContextSnapshot(hash) {
    if (typeof hash !== 'string' || !hash) return null;
    try {
      return await fs.readFile(path.join(this.contextDir, hash), 'utf8');
    } catch {
      return null;
    }
  }

  /** Хэши всех снимков, на которые ссылается журнал. */
  _referencedSnapshots() {
    const used = new Set();
    for (const bucket of Object.values(this.contextKnown())) {
      for (const e of Object.values(bucket || {})) if (e && typeof e.hash === 'string') used.add(e.hash);
    }
    return used;
  }

  // Удаляет снимки, на которые журнал больше не ссылается, сверх лимита — начиная со старых.
  async _pruneContextSnapshots() {
    let names;
    try {
      names = await fs.readdir(this.contextDir);
    } catch {
      return 0;
    }
    const used = this._referencedSnapshots();
    const orphan = names.filter((n) => !n.endsWith('.tmp') && !used.has(n));
    if (names.length - orphan.length <= CONTEXT_SNAPSHOT_LIMIT) return 0;
    const stats = await Promise.all(orphan.map(async (n) => {
      const st = await fs.stat(path.join(this.contextDir, n)).catch(() => null);
      return { n, mtime: st ? st.mtimeMs : 0 };
    }));
    stats.sort((a, b) => a.mtime - b.mtime);
    const drop = stats.slice(0, Math.max(0, names.length - CONTEXT_SNAPSHOT_LIMIT));
    for (const d of drop) await fs.rm(path.join(this.contextDir, d.n), { force: true });
    return drop.length;
  }

  // ---- проекты ----
  _key(p) { return process.platform === 'win32' ? p.toLowerCase() : p; }

  async addProject(absPath) {
    const norm = path.resolve(absPath);
    const existing = this.config.projects.find((p) => this._key(p.path) === this._key(norm));
    if (existing) return existing;
    const base = path.basename(norm) || 'project';
    const slug = base.toLowerCase().replace(/[^a-z0-9а-яё_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'project';
    const id = slug + '-' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 6);
    const project = { id, name: base, path: norm };
    this.config.projects.push(project);
    await this.saveConfig();
    return project;
  }

  async removeProject(id) {
    this.config.projects = this.config.projects.filter((p) => p.id !== id);
    for (const [chat, s] of Object.entries(this.config.sessions)) {
      if (s.projectId === id) delete this.config.sessions[chat];
    }
    if (this.config.lastProjectId === id) this.config.lastProjectId = null;
    if (this.config.modelSynced) delete this.config.modelSynced[id];
    await this.saveConfig();
  }

  getProject(id) { return this.config.projects.find((p) => p.id === id) || null; }

  getProposalDecision(chatId, contentHash) {
    return this.config.proposalDecisions?.[chatId]?.[contentHash] || null;
  }

  async setProposalDecision(chatId, contentHash, status, historyId = null, exitCode = null) {
    // 'executed' — статус предложений запуска и команд (этап C3c): у них нет записи
    // в историю и резервных копий, есть только факт выполнения и код возврата.
    if (!chatId || !contentHash || !['applied', 'rejected', 'dismissed', 'executed'].includes(status)) return;
    if (!this.config.proposalDecisions[chatId]) this.config.proposalDecisions[chatId] = {};
    const rec = { status, historyId: historyId || null, ts: Date.now() };
    // Код возврата храним только у выполненных: по нему карточка после перезапуска
    // показывает «Выполнено (код N)», а не просто «Выполнено».
    if (status === 'executed') rec.exitCode = Number.isFinite(exitCode) ? exitCode : null;
    this.config.proposalDecisions[chatId][contentHash] = rec;
    const entries = Object.entries(this.config.proposalDecisions[chatId]);
    if (entries.length > 5000) {
      entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      for (const [hash] of entries.slice(0, entries.length - 5000)) delete this.config.proposalDecisions[chatId][hash];
    }
    await this.saveConfig();
  }

  getProjectForChat(chatId) {
    const s = chatId && this.config.sessions[chatId];
    return s ? this.getProject(s.projectId) : null;
  }

  async bind(chatId, projectId) {
    if (!projectId) {
      delete this.config.sessions[chatId];
    } else {
      const p = this.getProject(projectId);
      if (!p) throw new Error('Проект не найден');
      this.config.sessions[chatId] = { projectId: p.id, projectPath: p.path };
      this.config.lastProjectId = p.id;
    }
    await this.saveConfig();
  }

  // ---- резервные копии ----
  async _rmBackup(id) {
    for (const ext of ['.before', '.after']) await fs.rm(path.join(this.backupDir, id + ext), { force: true });
  }

  /**
   * Хранит копии только для `keep` последних операций над каждым файлом.
   *
   * Записи идут в this.history в порядке добавления, поэтому при равных ts (несколько
   * операций в пределах одного миллисекунды) решаем по индексу. Без этого стабильная
   * сортировка оставляла бы порядок добавления, и slice(keep) отрезал бы НОВЫЕ записи
   * вместо старых — то есть удалялись бы самые нужные копии.
   */
  async pruneFile(projectId, relPath, keep = 2) {
    const list = this._newestFirst(
      this.history.filter((h) => h.projectId === projectId && h.relPath === relPath && h.status !== 'failed' && !h.pruned),
    );
    for (const h of list.slice(keep)) {
      await this._rmBackup(h.id);
      h.pruned = true;
    }
    if (list.length > keep) await this.saveHistory();
  }

  // Сортировка «сначала новые» с детерминированным решением при одинаковых ts
  _newestFirst(entries) {
    const index = new Map(entries.map((h, i) => [h, i]));
    return [...entries].sort((a, b) => (b.ts - a.ts) || (index.get(b) - index.get(a)));
  }

  async pruneAll(keep = 2) {
    const seen = new Set();
    for (const h of this.history) {
      const k = h.projectId + '\u0000' + h.relPath;
      if (seen.has(k)) continue;
      seen.add(k);
      await this.pruneFile(h.projectId, h.relPath, keep);
    }
  }

  /**
   * Убирает из журнала лишние записи об откате, оставляя `keep` последних на файл.
   * Файлы резервных копий при этом не удаляются — у записей об откате их нет.
   * @returns {Promise<number>} сколько записей удалено
   */
  async pruneRollbackRecords(projectId, relPath, keep = ROLLBACK_RECORD_LIMIT) {
    const list = this._newestFirst(
      this.history.filter((h) => h.projectId === projectId && h.relPath === relPath && h.source === 'rollback'),
    );
    if (list.length <= keep) return 0;
    const drop = new Set(list.slice(keep).map((h) => h.id));
    const before = this.history.length;
    this.history = this.history.filter((h) => !drop.has(h.id));
    await this.saveHistory();
    return before - this.history.length;
  }

  async backupStats() {
    let files = 0, bytes = 0;
    for (const name of await fs.readdir(this.backupDir).catch(() => [])) {
      const st = await fs.stat(path.join(this.backupDir, name)).catch(() => null);
      if (st && st.isFile()) { files++; bytes += st.size; }
    }
    return { files, bytes };
  }

  // Удаляет все копии; журнал операций остаётся (Diff и откат этих операций станут недоступны)
  async clearBackups() {
    const before = await this.backupStats();
    for (const name of await fs.readdir(this.backupDir).catch(() => [])) {
      await fs.rm(path.join(this.backupDir, name), { force: true });
    }
    for (const h of this.history) if (h.status !== 'failed') h.pruned = true;
    await this.saveHistory();
    return before;
  }

  // ---- генератор промптов ----
  async setPromptDraft(sections) {
    this.config.promptDraft = sections;
    await this.saveConfig();
  }
  getTreeOff(projectId) { return this.config.promptTreeOff[projectId] || []; }
  async setTreeOff(projectId, list) {
    if (list.length) this.config.promptTreeOff[projectId] = list;
    else delete this.config.promptTreeOff[projectId];
    await this.saveConfig();
  }
  listPresets() { return this.config.promptPresets.map((p) => ({ id: p.id, name: p.name })); }
  getPreset(id) { return this.config.promptPresets.find((p) => p.id === id) || null; }
  async savePreset(name, sections) {
    const existing = this.config.promptPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (existing) { existing.sections = sections; existing.name = name; }
    else this.config.promptPresets.push({ id: crypto.randomUUID(), name, sections });
    await this.saveConfig();
  }
  async deletePreset(id) {
    this.config.promptPresets = this.config.promptPresets.filter((p) => p.id !== id);
    await this.saveConfig();
  }

  // ---- история ----
  addHistory(entry) {
    this.history.push({ ...entry, source: normalizeSource(entry && entry.source) });
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    return this.saveHistory();
  }
  getHistory(id) { return this.history.find((h) => h.id === id) || null; }
  updateHistory(id, patch) {
    const h = this.getHistory(id);
    if (h) Object.assign(h, patch);
    return this.saveHistory();
  }
}

module.exports = { Store, HISTORY_SOURCES, ROLLBACK_RECORD_LIMIT, CONTEXT_SNAPSHOT_MAX_CHARS, CONTEXT_SNAPSHOT_LIMIT };
