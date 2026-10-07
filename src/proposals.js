'use strict';
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { parseBlock } = require('./parser');
const { resolveInProject, normalizeRel } = require('./paths');
const { diffLines, diffStats, toRows, toUnifiedDiff } = require('./diff');
const fileops = require('./fileops');
const { ABSENT, classifyVersions } = require('./versions');
const Context = require('./context');
const editorfs = require('./editorfs');
const { applyEdits } = require('./patch');
// Трёхстороннее слияние живёт в src/hunks.js (UMD): тем же кодом пользуется renderer
// при принятии предложения в буфер редактора — правило слияния должно быть одно.
const { merge3 } = require('./hunks');

const MAX_BACKUPS_PER_FILE = 2;

// Что именно отправляется модели вместе с diff'ом. Формат объясняется явно: модель должна
// понять, что «+» — это текущее содержимое, иначе её блоки SEARCH не совпадут с файлом.
const COPY_PREAMBLE = `ЭТИ ФАЙЛЫ ИЗМЕНИЛИСЬ С ТЕХ ПОР, КАК ТЫ ВИДЕЛА ИХ ПОСЛЕДНЮЮ ВЕРСИЮ

Формат — обычный unified diff. Строки с «-» были в той версии, которую ты видела; строки с «+»
есть в файле сейчас; строки с пробелом в начале — неизменённый контекст. Заголовки @@ -a,b +c,d @@
дают номера строк. Актуальна версия «после».

Учти это, прежде чем предлагать правки: фрагменты в твоих блоках SEARCH должны совпадать
с ТЕКУЩИМ содержимым файла, а не с тем, которое ты видела раньше.

Если точная версия файла не сохранилась, он приведён целиком — это оговорено в его заголовке.`;
// Сколько файлов журнала проверяем за один запрос: проверка требует чтения каждого.
// Совпадает с внутренним лимитом editorfs.hashesForEditor.
const MAX_DIVERGENCE_CHECK = 200;
// Общий бюджет на копируемый текст. Diff обычно в разы меньше файла, но при массовой
// переписке и он может раздуться — молча обрезать список нельзя, поэтому он возвращается.
const MAX_COPY_CHARS = 4_000_000;

const MAX_ROWS = 4000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
const countLines = (t) => (t === '' ? 0 : t.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length);
// Модель иногда пишет путь вместе с именем корневой папки («myproject/test.py»), хотя она уже в корне.
// Отбрасываем это имя, если внутри проекта нет настоящей подпапки с таким названием.
async function stripRootPrefix(rootAbs, relInput) {
  const n = normalizeRel(relInput);
  if (!n.ok) return null;
  const parts = n.rel.split('/');
  if (parts.length < 2 || parts[0].toLowerCase() !== path.basename(path.resolve(rootAbs)).toLowerCase()) return null;
  try {
    if ((await fs.stat(path.join(rootAbs, parts[0]))).isDirectory()) return null;
  } catch { /* подпапки нет — значит, это имя корня */ }
  return parts.slice(1).join('/');
}

class ProposalManager {
  constructor({ store, onChange, trash }) {
    this.store = store;
    this.onChange = onChange || (() => {});
    this.trash = trash;
    this.map = new Map(); // id -> proposal
    this.byKey = new Map(); // `${chatId}:${key}` -> id
    this.hashes = new Set(); // `${chatId}:${contentHash}` — защита от дублей
  }

  // blocks: [{key, text, initial}]
  ingest(chatId, blocks) {
    let changed = false;
    for (const b of blocks) {
      const parsed = parseBlock(b.text);
      if (!parsed.marker) continue;
      const hash = sha([chatId, parsed.marker.op, parsed.marker.path, parsed.content].join('\0'));
      const k = `${chatId}:${b.key}`;
      const ex = this.map.get(this.byKey.get(k));
      // Блок, который мы уже разбирали в этом чате, новым стать не может. Без этого при
      // прокрутке чата вверх DeepSeek догружает старые сообщения, их блоки приходят позже
      // базового окна preload-chat.js (2.5 с) и предлагаются как свежие правки.
      const seenBefore = Context.wasSeen(this.store.contextSeen(), chatId, hash);
      Context.markSeen(this.store.contextSeen(), chatId, hash);

      if (ex) {
        if (ex.contentHash === hash) continue;
        if (ex.status === 'pending') {
          // тот же DOM-блок дописывается/меняется — обновляем предложение
          const same = ex.marker.op === parsed.marker.op && ex.marker.path === parsed.marker.path;
          Object.assign(ex, {
            marker: parsed.marker,
            content: parsed.content,
            mode: parsed.mode,
            edits: parsed.edits,
            patchIssues: parsed.issues,
            patchOpen: parsed.open,
            incomplete: parsed.incomplete,
            contentHash: hash,
            override: same ? ex.override : null,
            // aiBaseHash намеренно не трогаем: блок дописывается по мере стриминга,
            // а версия файла на диске, которую видела модель, от этого не меняется.
          });
          this.hashes.add(`${chatId}:${hash}`);
          changed = true;
          continue;
        }
      }
      if (this.hashes.has(`${chatId}:${hash}`)) continue;

      const decision = this.store.getProposalDecision(chatId, hash);
      if (decision?.status === 'dismissed') {
        this.hashes.add(`${chatId}:${hash}`);
        continue;
      }

      const p = {
        id: crypto.randomUUID(),
        chatId,
        key: b.key,
        marker: parsed.marker,
        content: parsed.content,
        mode: parsed.mode,
        edits: parsed.edits,
        patchIssues: parsed.issues,
        patchOpen: parsed.open,
        incomplete: parsed.incomplete,
        contentHash: hash,
        status: decision?.status || 'pending', // pending | applied | rejected
        historical: !!b.initial || seenBefore,
        // Stage 0 (ТЗ §37): версия файла, которую видела модель. Заполняется из sealAiBase()
        // сразу после ingest — сам ingest синхронный и диск не читает.
        // null = «ещё не запечатано», ABSENT = «файла не существовало».
        aiBaseHash: null,
        aiBaseSealedAt: null,
        override: null,
        dismissed: false,
        historyId: decision?.historyId || null,
        createdAt: Date.now(),
      };
      this.map.set(p.id, p);
      this.byKey.set(k, p.id);
      this.hashes.add(`${chatId}:${hash}`);
      changed = true;
    }
    if (changed) this.onChange();
    return changed;
  }

  /**
   * Stage 0 (ТЗ §37): печатает aiBaseHash — версию файла на диске в момент появления
   * предложения. ingest() синхронный и диск не читает, поэтому печать вынесена в отдельный
   * шаг; main.js вызывает его сразу после ingest и после привязки проекта.
   *
   * Исторические блоки (initial: true) не печатаются намеренно: они пришли из уже открытого
   * чата, диск с тех пор мог измениться, и честный ответ здесь — «неизвестно», а не
   * «модель видела текущую версию».
   *
   * @returns {Promise<number>} сколько предложений запечатано
   */
  async sealAiBase(chatId) {
    // Отметки «блок уже видели» проставлены синхронно в ingest — сохраняем их здесь.
    await this.store.saveContext().catch((e) => console.error('[context]', e));
    let sealed = 0;
    for (const p of this.map.values()) {
      if (p.chatId !== chatId || p.status !== 'pending' || p.historical) continue;
      if (p.aiBaseHash !== null) continue;
      const h = await this._readAiBaseHash(p);
      if (h === undefined) continue; // проект не привязан или путь не проходит проверку — повторим позже
      p.aiBaseHash = h;
      p.aiBaseSealedAt = Date.now();
      sealed++;
    }
    return sealed;
  }

  // undefined — «определить не удалось, попробуем позже»; ABSENT — «файла не существует»
  async _readAiBaseHash(p) {
    const project = this.store.getProjectForChat(p.chatId);
    if (!project) return undefined;
    const target = p.override || p.marker;
    const stripped = await stripRootPrefix(project.path, target.path);
    const r = await resolveInProject(project.path, stripped || target.path);
    if (!r.ok) return undefined;
    if (!r.exists || !r.isFile) return ABSENT;
    const cur = await fileops.readRawFile(r.abs);
    return cur.error ? undefined : cur.hash;
  }

  get(id) { return this.map.get(id) || null; }

  /**
   * Последняя операция Whale Bridge над файлом — точка отсчёта для «изменён ли файл вручную».
   *
   * Записи об откате учитываются, хотя резервных копий у них нет (hashOnly): их afterHash
   * точно описывает то, что теперь на диске. Без этого после принудительного отката старой
   * операции точкой отсчёта осталась бы более новая запись, её afterHash не совпал бы с
   * диском, и приложение показывало бы ложное «файл изменён вручную».
   */
  async _manualBase(projectId, relPath) {
    const h = [...this.store.history]
      .filter((x) => x.projectId === projectId && x.relPath === relPath && x.status === 'applied' && x.afterHash
        && (!x.pruned || x.source === 'rollback'))
      .sort((a, b) => b.ts - a.ts)[0];
    if (!h) return null;
    const project = this.store.getProject(projectId);
    if (!project) return null;
    const r = await resolveInProject(project.path, relPath);
    if (!r.ok || !r.exists || !r.isFile) return null;
    const cur = await fileops.readRawFile(r.abs);
    if (cur.error || cur.hash === h.afterHash) return null;
    return { history: h, project, abs: r.abs, current: cur, hashOnly: h.source === 'rollback' };
  }

  /**
   * Текущая версия файла против той, что известна модели в этом чате.
   *
   * Это и есть правильный вопрос. Прежний («диск против последней записи истории Whale
   * Bridge») давал три сбоя: файл без истории приложения не проверялся вовсе, сохранение
   * в редакторе само себя «гасило», а учёт обнулялся вместе с сессией.
   *
   * Файла нет в журнале — значит, модель его никогда не видела: сравнивать не с чем,
   * и расхождением это не является (иначе подсвечивался бы весь проект).
   *
   * @param diskHash передайте, если файл уже прочитан, чтобы не читать его второй раз
   */
  async _divergence(chatId, projectId, relPath, diskHash) {
    const known = Context.knownVersion(this.store.contextKnown(), chatId, projectId, relPath);
    if (!known) return { diverged: false, known: null, diskHash: null };
    let hash = diskHash;
    if (hash === undefined) {
      const project = this.store.getProject(projectId);
      if (!project) return { diverged: false, known, diskHash: null };
      const r = await resolveInProject(project.path, relPath);
      if (!r.ok) return { diverged: false, known, diskHash: null };
      if (!r.exists || !r.isFile) return { diverged: true, known, diskHash: null };
      const cur = await fileops.readRawFile(r.abs);
      if (cur.error) return { diverged: false, known, diskHash: null };
      hash = cur.hash;
    }
    return { diverged: hash !== known.hash, known, diskHash: hash == null ? null : hash };
  }

  // Хэш файла для записи в историю: ABSENT — файла нет, null — путь недоступен или не читается.
  async _hashAt(root, rel) {
    if (!rel) return null;
    const r = await resolveInProject(root, rel);
    if (!r.ok) return null;
    if (!r.exists || !r.isFile) return ABSENT;
    const cur = await fileops.readRawFile(r.abs);
    return cur.error ? null : cur.hash;
  }

  // Обёртка над _evaluate: добавляет версию, которую видела модель, и её сравнение с диском.
  // Полную классификацию (aiBase/disk/saved/editor) делает renderer — только он знает буфер.
  async evaluate(p) {
    const ev = await this._evaluate(p);
    if (ev && ev.baseHash !== undefined && ev.aiBaseHash != null) {
      ev.aiStale = ev.aiBaseHash !== ev.baseHash;
      ev.versions = classifyVersions({ aiBase: ev.aiBaseHash, disk: ev.baseHash });
    }
    return ev;
  }

  async _evaluate(p) {
    const target = p.override || p.marker;
    const out = {
      id: p.id,
      status: p.status,
      op: target.op,
      relPath: target.path,
      historical: p.historical,
      mode: p.mode,
      patchBlocks: p.mode === 'patch' ? p.edits.length : 0,
      incomplete: p.incomplete,
      shrink: null,
      suggestions: [],
      state: p.status,
      contentHash: p.contentHash,
      historyId: p.historyId,
      aiBaseHash: p.aiBaseHash,
    };
    if (p.status !== 'pending') return out;

    const project = this.store.getProjectForChat(p.chatId);
    if (!project) return { ...out, state: 'no-project' };

    const stripped = await stripRootPrefix(project.path, target.path);
    if (stripped) out.pathFixed = { from: target.path, to: stripped };
    const r = await resolveInProject(project.path, stripped || target.path);
    if (!r.ok) return { ...out, state: 'invalid-path', error: r.error };
    out.relPath = r.rel;
    out.projectId = project.id;

    if (target.op === 'delete') {
      if (!r.exists || !r.isFile) return { ...out, state: 'missing' };
      const cur = await fileops.readRawFile(r.abs);
      if (cur.error) return { ...out, state: 'unreadable', error: cur.error };
      const decoded = await fileops.readTextFile(r.abs);
      if (decoded.error) {
        return { ...out, state: 'delete', ops: [], stats: { added: 0, removed: 0 }, baseHash: cur.hash, newText: null, encodingWarning: decoded.error };
      }
      const ops = diffLines(decoded.text, '');
      return { ...out, state: 'delete', ops, stats: diffStats(ops), baseHash: cur.hash, newText: '' };
    }

    if (target.op === 'move') {
      if (!target.toPath) return { ...out, state: 'invalid-path', error: 'Для MOVE нужен формат «старый -> новый»' };
      const strippedTo = await stripRootPrefix(project.path, target.toPath);
      if (strippedTo) out.toPathFixed = { from: target.toPath, to: strippedTo };
      const dest = await resolveInProject(project.path, strippedTo || target.toPath);
      if (!dest.ok) return { ...out, state: 'invalid-path', error: dest.error };
      out.toRelPath = dest.rel;
      if (!r.exists || !r.isFile) return { ...out, state: 'missing' };
      if (dest.exists) return { ...out, state: 'exists', error: 'Файл назначения уже существует' };
      const cur = await fileops.readRawFile(r.abs);
      if (cur.error) return { ...out, state: 'unreadable', error: cur.error };
      const decoded = await fileops.readTextFile(r.abs);
      return { ...out, state: 'move', stats: { added: 0, removed: 0 }, baseHash: cur.hash, newText: decoded.error ? null : decoded.text, encodingWarning: decoded.error || null, expectedNewHash: ABSENT, needsDirs: !dest.parentExists };
    }

    if (target.op === 'update') {
      if (!r.exists || !r.isFile) {
        out.suggestions = await fileops.suggestPaths(project.path, r.rel);
        return { ...out, state: 'missing' };
      }
      const cur = await fileops.readTextFile(r.abs);
      if (cur.error) return { ...out, state: 'unreadable', error: cur.error };
      // Модель не знает текущую версию файла — независимо от того, кто и как её изменил:
      // внешний редактор, сохранение в нашем редакторе, откат, сборка, VCS.
      const div = await this._divergence(p.chatId, project.id, r.rel, cur.hash);
      if (div.diverged) {
        out.manualChanged = true; // прежнее имя поля: его уже использует интерфейс
        out.contextDiverged = true;
        out.knownVersion = {
          hash: div.known.hash, source: div.known.source,
          label: Context.SOURCE_LABEL[div.known.source] || div.known.source, ts: div.known.ts,
        };
        const manual = await this._manualBase(project.id, r.rel);
        if (manual) out.manualHistoryId = manual.history.id;
      }
      let newText = p.content;
      if (p.mode === 'patch') {
        if (p.patchIssues.length) return { ...out, state: 'patch-failed', error: p.patchIssues.join('; ') };
        if (p.patchOpen) return { ...out, state: 'patch-open' };
        if (!p.edits.length) return { ...out, state: 'patch-failed', error: 'В ответе нет ни одного блока SEARCH/REPLACE' };
        const res = applyEdits(cur.text, p.edits);
        out.patchResults = res.results;
        if (!res.ok) return { ...out, state: 'patch-failed', error: res.error };
        newText = res.text;
      }
      const ops = diffLines(cur.text, newText);
      const stats = diffStats(ops);
      const oldN = countLines(cur.text), newN = countLines(newText);
      if (oldN >= 20 && newN < oldN * 0.5) {
        out.shrink = `Новая версия короче исходной на ${Math.round((1 - newN / oldN) * 100)}% (${oldN} → ${newN} строк)`;
      }
      return { ...out, state: stats.added + stats.removed === 0 ? 'identical' : 'update', ops, stats, baseHash: cur.hash, newText };
    }

    // create
    if (r.exists) return { ...out, state: 'exists' };
    if (p.mode === 'patch') {
      return { ...out, state: 'patch-failed', error: 'SEARCH/REPLACE нельзя использовать для нового файла — нужен полный текст файла' };
    }
    const ops = diffLines('', p.content);
    return { ...out, state: 'create', ops, stats: diffStats(ops), baseHash: ABSENT, needsDirs: !r.parentExists, newText: p.content };
  }

  async list(chatId, includeHistorical) {
    const items = [...this.map.values()]
      .filter((p) => !p.dismissed && p.chatId === chatId && (includeHistorical || !p.historical || p.status !== 'pending'))
      .sort((a, b) => b.createdAt - a.createdAt);
    const out = [];
    for (const p of items) {
      const ev = await this.evaluate(p);
      out.push({
        id: ev.id, status: ev.status, state: ev.state, op: ev.op, relPath: ev.relPath,
        mode: ev.mode, patchBlocks: ev.patchBlocks, pathFixed: !!ev.pathFixed, toRelPath: ev.toRelPath || null,
        historical: ev.historical, stats: ev.stats || null,
        encodingWarning: ev.encodingWarning || null,
        manualChanged: !!ev.manualChanged,
        contextDiverged: !!ev.contextDiverged,
        knownVersion: ev.knownVersion || null,
        manualHistoryId: ev.manualHistoryId || null,
        warnings: ev.incomplete.length + (ev.shrink ? 1 : 0),
      });
    }
    return out;
  }

  async view(id) {
    const p = this.get(id);
    if (!p) return null;
    const ev = await this.evaluate(p);
    const rows = ev.ops ? toRows(ev.ops, 3) : [];
    delete ev.ops;
    // Тексты для Monaco DiffEditor (этап C). Читаются только здесь, а не в evaluate:
    // список предложений ходит в IPC часто, а полное содержимое файлов нужно лишь
    // открытому просмотру. baseText — что на диске сейчас; aiBaseText — снимок версии,
    // которую видела модель (null, если снимка нет: интерфейс обязан это оговорить).
    let baseText = null;
    if (ev.projectId && (ev.op === 'update' || ev.op === 'delete') && (ev.state === 'update' || ev.state === 'delete')) {
      const project = this.store.getProject(ev.projectId);
      if (project) {
        const r = await resolveInProject(project.path, ev.relPath);
        if (r.ok && r.exists && r.isFile) {
          const cur = await fileops.readTextFile(r.abs);
          if (!cur.error) baseText = cur.text;
        }
      }
    }
    const aiBaseText = p.aiBaseHash ? await this.store.readContextSnapshot(p.aiBaseHash) : null;
    return {
      ...ev,
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
      newText: ev.newText ?? null, // итоговый файл (для патча — после применения блоков)
      rawText: p.content, // как прислал ИИ
      baseText,
      aiBaseText: aiBaseText ?? null,
    };
  }

  retarget(id, { relPath, op }) {
    const p = this.get(id);
    if (!p || p.status !== 'pending') throw new Error('Предложение недоступно');
    if (op !== 'update' && op !== 'create') throw new Error('Неверный тип операции');
    p.override = { op, path: String(relPath) };
    this.onChange();
  }

  // Убрать карточку из списка. Хэш содержимого остаётся в this.hashes, поэтому тот же блок не вернётся
  dismiss(id) {
    const p = this.get(id);
    if (p) {
      p.dismissed = true;
      if (p.status === 'pending') this.store.setProposalDecision(p.chatId, p.contentHash, 'dismissed').catch((e) => console.error('[proposal decision]', e));
      this.onChange();
    }
  }

  dismissAll(chatId, includeHistorical) {
    for (const p of this.map.values()) {
      if (p.chatId !== chatId || p.dismissed) continue;
      if (p.historical && p.status === 'pending' && !includeHistorical) continue;
      p.dismissed = true;
      if (p.status === 'pending') this.store.setProposalDecision(p.chatId, p.contentHash, 'dismissed').catch((e) => console.error('[proposal decision]', e));
    }
    this.onChange();
  }

  reject(id) {
    const p = this.get(id);
    if (p && p.status === 'pending') {
      p.status = 'rejected';
      this.store.setProposalDecision(p.chatId, p.contentHash, 'rejected').catch((e) => console.error('[proposal decision]', e));
      this.onChange();
    }
  }

  async apply(id, { baseHash, contentHash, allowIncomplete, createDirs }) {
    const p = this.get(id);
    if (!p || p.status !== 'pending') return { ok: false, code: 'state', error: 'Предложение уже обработано' };
    if (contentHash !== p.contentHash) {
      return { ok: false, code: 'changed', error: 'Предложение изменилось, пока вы смотрели Diff. Проверьте заново.' };
    }
    const ev = await this.evaluate(p);
    if (!['update', 'create', 'delete', 'move'].includes(ev.state)) {
      return { ok: false, code: 'state', error: 'Это предложение сейчас нельзя применить (' + ev.state + ')' };
    }
    if ((ev.incomplete.length || ev.shrink) && !allowIncomplete) {
      return { ok: false, code: 'incomplete', error: 'Ответ похож на неполный. Подтвердите применение явно.' };
    }
    if (ev.baseHash !== baseHash) {
      return { ok: false, code: 'conflict', error: 'Файл изменился после формирования Diff. Проверьте обновлённый Diff.' };
    }

    const project = this.store.getProject(ev.projectId);
    const opId = crypto.randomUUID();
    const res = await fileops.applyChange({
      root: project.path,
      rel: ev.relPath,
      op: ev.op,
      newRel: ev.toRelPath,
      newText: ev.newText,
      expectedHash: baseHash,
      expectedNewHash: ev.expectedNewHash,
      createDirs: !!createDirs,
      backupDir: this.store.backupDir,
      opId,
      trash: this.trash,
    });

    const base = {
      id: opId, ts: Date.now(), chatId: p.chatId, projectId: project.id, projectName: project.name,
      relPath: ev.relPath, op: ev.op, newRelPath: ev.toRelPath || null,
    };
    if (!res.ok) {
      if (res.code === 'io') await this.store.addHistory({ ...base, status: 'failed', error: res.error, source: 'ai' });
      return res;
    }
    await this.store.addHistory({
      ...base, status: 'applied', beforeHash: res.beforeHash, afterHash: res.afterHash, error: null, proposalHash: p.contentHash,
      source: 'ai', // ТЗ §10: запись инициирована предложением модели
      aiBaseHash: p.aiBaseHash,
    });
    await this.store.pruneFile(project.id, ev.relPath, MAX_BACKUPS_PER_FILE).catch((e) => console.error('[prune]', e));
    // Содержимое получено от модели — значит, эта версия ей известна. Для move берём новый путь.
    if (res.afterHash && p.chatId) {
      Context.record(this.store.contextKnown(), p.chatId, {
        projectId: project.id, relPath: ev.toRelPath || ev.relPath,
        hash: res.afterHash, source: 'applied', historyId: opId,
      });
      // Снимок содержимого: без него журнал знает только хэш, и на «а что именно изменилось»
      // ответить нечем — сравнение версии модели с диском построить нельзя.
      await this.store.saveContextSnapshot(res.afterHash, ev.newText || '');
      await this.store.saveContext().catch((e) => console.error('[context]', e));
    }
    p.status = 'applied';
    p.historyId = opId;
    await this.store.setProposalDecision(p.chatId, p.contentHash, 'applied', opId);
    this.onChange();
    return { ok: true, historyId: opId };
  }

  /**
   * Предложение было записано на диск НЕ через apply(), а сохранением из редактора:
   * пользователь принял изменения (целиком или выбранные ханки) в буфер, возможно
   * смешал со своими правками, и нажал Ctrl+S (этап C, §20–§21).
   *
   * Отличия от apply() принципиальные:
   *   - текст на диске может НЕ равняться тексту предложения — поэтому журнал контекста
   *     здесь не трогается: правило «модель знает версию» ставит main только когда
   *     сохранённое содержимое байт в байт равно предложенному (честный учёт);
   *   - история и резервные копии уже созданы editorfs.writeFromEditor (source: 'ai').
   */
  markAppliedExternally(id, { historyId }) {
    const p = this.get(id);
    if (!p || p.status !== 'pending') return false;
    p.status = 'applied';
    p.historyId = historyId || null;
    this.store.setProposalDecision(p.chatId, p.contentHash, 'applied', historyId || null)
      .catch((e) => console.error('[proposal decision]', e));
    this.onChange();
    return true;
  }

  // ---- история ----
  listHistory(projectId) {
    return [...this.store.history]
      .filter((h) => !projectId || h.projectId === projectId)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 200);
  }

  async historyView(id) {
    const h = this.store.getHistory(id);
    if (!h) return null;
    if (h.pruned) return { ...h, rows: [], stats: { added: 0, removed: 0 }, missingBackup: true };
    const read = async (ext) => {
      try {
        const buf = await fs.readFile(path.join(this.store.backupDir, id + ext));
        const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        return buf.subarray(bom ? 3 : 0).toString('utf8');
      } catch {
        return null;
      }
    };
    const before = h.op === 'create' ? '' : await read('.before');
    const after = await read('.after');
    if (before == null || after == null) return { ...h, rows: [], stats: { added: 0, removed: 0 }, missingBackup: true };
    const ops = diffLines(before, after);
    // beforeText/afterText — обе стороны для Monaco DiffEditor (этап C)
    return { ...h, rows: toRows(ops, 3).slice(0, MAX_ROWS), stats: diffStats(ops), beforeText: before, afterText: after };
  }


  /**
   * Файлы, чья текущая версия отличается от той, что известна модели в этом чате.
   *
   * В отличие от прежнего listManualChanges, список строится по журналу контекста, а не по
   * истории операций Whale Bridge. Поэтому в него попадают и файлы, которые приложение
   * никогда не записывало, но показывало модели (скопировали в промпт, подтвердили вручную).
   *
   * Проверка требует чтения каждого файла, поэтому список ограничен MAX_DIVERGENCE_CHECK;
   * факт обрезки возвращается явно, чтобы интерфейс мог об этом сказать.
   */
  async listDivergences(chatId, projectId, limit = MAX_DIVERGENCE_CHECK) {
    const empty = { items: [], checked: 0, truncated: false };
    if (!chatId || !projectId) return empty;
    const project = this.store.getProject(projectId);
    if (!project) return empty;
    const known = this.store.contextKnown();
    const all = Context.entries(known, chatId, projectId);
    if (!all.length) return empty;
    const slice = all.slice(0, limit);
    const disk = await editorfs.hashesForEditor(project, slice.map((e) => e.relPath));
    const items = Context.divergences(known, chatId, projectId, disk);
    items.sort((x, y) => (y.knownTs || 0) - (x.knownTs || 0));
    return { items, checked: slice.length, truncated: all.length > slice.length };
  }

  /**
   * Сравнение «что знала модель → что сейчас на диске».
   *
   * База сравнения — снимок версии из журнала контекста, а НЕ резервная копия последней
   * операции Whale Bridge. Это разные вещи: после отката, сохранения в редакторе или
   * внешней правки копия последней операции уже не описывает то, что видела модель, и
   * прежняя схема на таких файлах отвечала «резервной копии нет».
   */
  async manualView(chatId, projectId, relPath) {
    const project = this.store.getProject(projectId);
    if (!project) return null;
    const div = await this._divergence(chatId, projectId, relPath);
    const knownVersion = div.known ? {
      hash: div.known.hash, source: div.known.source, ts: div.known.ts,
      label: Context.SOURCE_LABEL[div.known.source] || div.known.source,
    } : null;

    const r = await resolveInProject(project.path, relPath);
    if (!r.ok) return { relPath, diverged: div.diverged, knownVersion, error: r.error };
    if (!r.exists || !r.isFile) {
      return {
        relPath, diverged: div.diverged, knownVersion, missing: true,
        error: div.diverged ? 'Файл удалён или недоступен: модель знает версию, которой больше нет.' : null,
      };
    }
    const current = await fileops.readTextFile(r.abs);
    if (current.error) return { relPath, diverged: div.diverged, knownVersion, error: current.error };

    if (!div.diverged) {
      return {
        relPath, diverged: false, knownVersion, currentHash: current.hash, currentText: current.text,
        rows: [], stats: { added: 0, removed: 0 },
        note: 'Модель знает текущую версию файла — сравнивать нечего.',
      };
    }

    const knownText = div.known ? await this.store.readContextSnapshot(div.known.hash) : null;
    if (knownText != null) {
      const ops = diffLines(knownText, current.text);
      const rows = toRows(ops, 3);
      return {
        relPath, diverged: true, knownVersion, base: 'context',
        currentHash: current.hash, currentText: current.text,
        // baseText — вторая сторона для Monaco DiffEditor (этап C): точная версия модели
        baseText: knownText,
        stats: diffStats(ops), rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS,
      };
    }

    // Снимка нет (версия слишком большая, записана до появления снимков или уже вытеснена).
    // Пробуем резервную копию последней операции — это хуже, но лучше, чем пустой экран.
    const manual = await this._manualBase(projectId, relPath);
    if (manual && !manual.hashOnly) {
      const after = await fs.readFile(path.join(this.store.backupDir, manual.history.id + '.after'), 'utf8').catch(() => null);
      if (after != null) {
        const baseText = after.replace(/^\uFEFF/, '');
        const ops = diffLines(baseText, current.text);
        const rows = toRows(ops, 3);
        return {
          relPath, diverged: true, knownVersion, base: 'backup', historyId: manual.history.id,
          afterHash: manual.history.afterHash, currentHash: current.hash, currentText: current.text,
          baseText, // приближение: версия после последней операции Whale Bridge, не обязательно та, что видела модель
          stats: diffStats(ops), rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS,
          notice: 'Точной версии, которую видела модель, нет — показано сравнение с последней операцией Whale Bridge.',
        };
      }
    }
    return {
      relPath, diverged: true, knownVersion, noBase: true, currentHash: current.hash, currentText: current.text,
      error: 'Расхождение определено по SHA-256, для него содержимое не нужно. А вот показать построчно нечего: точный текст версии, которую видела модель, не сохранён — отметка появилась до того, как приложение начало хранить снимки, либо файл больше 1 МБ. Передайте модели текущую версию и подтвердите это.',
    };
  }

  /**
   * Копирует текущие версии файлов, о которых модель знает устаревшее.
   *
   * Копирование НЕ снимает предупреждений: скопировать в буфер — не значит отправить
   * в чат, а ложное «модель знает» хуже заметного, потому что скрывает уехавший контекст.
   * Отметку ставит только явное действие — «✓ Модель проинформирована».
   */
  async copyDivergentVersions(chatId, projectId) {
    const { items } = await this.listDivergences(chatId, projectId);
    if (!items.length) return { ok: false, error: 'Расхождений нет: модель знает текущие версии всех отслеживаемых файлов' };
    const project = this.store.getProject(projectId);
    if (!project) return { ok: false, error: 'Проект не найден' };

    const parts = [COPY_PREAMBLE];
    const skipped = [];
    let chars = 0;
    let asDiff = 0;
    let asFull = 0;
    for (const item of items) {
      const r = await resolveInProject(project.path, item.relPath);
      if (!r.ok || !r.exists || !r.isFile) { skipped.push(item.relPath + ' (недоступен)'); continue; }
      const cur = await fileops.readTextFile(r.abs);
      if (cur.error) { skipped.push(`${item.relPath} (${cur.error})`); continue; }

      // По умолчанию — diff, а не файл целиком: передавать миллион строк ради одной
      // заменённой строки импорта значит выбросить контекст модели.
      const knownText = item.missing ? null : await this.store.readContextSnapshot(item.knownHash);
      let block = null;
      let usedDiff = false;
      if (knownText != null) {
        const diff = toUnifiedDiff(knownText, cur.text, {
          context: 3,
          oldLabel: `${item.relPath} (версия, которую ты видела последней)`,
          newLabel: `${item.relPath} (текущая версия на диске)`,
        });
        const fenced = '```diff\n' + diff + '```';
        // Файл переписан почти целиком или очень мал — diff выходит длиннее самого файла,
        // выгоднее послать файл. Сравниваем с «честной» длиной файла: оговорка про
        // несохранённую версию здесь ни при чём, она относится только к ветке без снимка.
        const fullPlain = `--- ${item.relPath} ---\n${cur.text}`;
        if (diff && fenced.length < fullPlain.length) { block = fenced; usedDiff = true; } else { block = fullPlain; }
      } else {
        block = `--- ${item.relPath} --- (точная версия, которую ты видела, не сохранена — вот текущий файл целиком)\n${cur.text}`;
      }
      if (chars + block.length > MAX_COPY_CHARS) {
        skipped.push(item.relPath + ' (лимит общего объёма)');
        continue;
      }
      chars += block.length;
      if (usedDiff) asDiff++; else asFull++;
      parts.push(block);
    }
    if (!asDiff && !asFull) {
      return { ok: false, error: 'Ни один из файлов с расхождением не удалось подготовить: ' + (skipped.join('; ') || 'неизвестная причина') };
    }
    if (skipped.length) parts.push('--- Не подготовлено ---\n' + skipped.map((x) => '- ' + x).join('\n'));
    const text = parts.join('\n\n');
    return {
      ok: true, length: text.length, files: asDiff + asFull, text,
      // payloadChars — объём самих файлов без преамбулы: по нему видно выигрыш от diff'а
      payloadChars: chars,
      asDiff, asFull, skipped: skipped.length, truncated: skipped.length > 0,
    };
  }

  async buildChatReport(chatId) {
    const items = [...this.map.values()].filter((x) => x.chatId === chatId && !x.dismissed).sort((a, b) => a.createdAt - b.createdAt);
    if (!items.length) return { ok: false, error: 'В этом чате пока нет предложений изменений' };
    const lines = ['ОТЧЁТ WHALE BRIDGE ПО ИЗМЕНЕНИЯМ', ''];
    for (const p of items) {
      const ev = await this.evaluate(p);
      let manualChanged = !!ev.manualChanged;
      let manualProjectId = ev.projectId || null;
      let manualRelPath = ev.relPath;
      if (!manualChanged && p.status === 'applied' && p.historyId) {
        const h = this.store.getHistory(p.historyId);
        if (h) {
          manualProjectId = h.projectId;
          manualRelPath = h.relPath;
          manualChanged = (await this._divergence(chatId, h.projectId, h.relPath)).diverged;
        }
      }
      const status = p.status === 'applied' ? 'применён' : p.status === 'rejected' ? 'отклонён' : ev.state;
      lines.push(`- ${ev.relPath}: ${status}`);
      if (ev.patchResults?.length) ev.patchResults.forEach((r, i) => lines.push(`  Блок ${i + 1}: ${r.status === 'ok' ? 'применён' : r.status === 'skipped' ? 'пропущен' : 'не применён'}${r.hint ? ` — ${r.hint}` : ''}`));
      else if (ev.state === 'patch-failed' && ev.error) lines.push(`  Причина: ${ev.error}`);
      if (manualChanged) {
        lines.push('  ⚠ Файл изменён после того, как модель видела его последнюю версию.');
        const manual = manualProjectId ? await this.manualView(chatId, manualProjectId, manualRelPath) : null;
        if (manual?.rows?.length) {
          lines.push('  DIFF: последняя версия Whale Bridge → текущая версия на диске');
          for (const row of manual.rows) {
            if (row.type === 'skip') lines.push(`  ... ${row.count} неизменённых строк ...`);
            else if (row.type === 'eq') lines.push(`    ${row.text}`);
            else if (row.type === 'del') lines.push(`  - ${row.text}`);
            else if (row.type === 'add') lines.push(`  + ${row.text}`);
          }
          if (manual.truncated) lines.push('  ... DIFF сокращён, слишком большой для отчёта ...');
        } else lines.push('  DIFF недоступен: резервная копия предыдущей версии была удалена.');
      }
      lines.push('');
    }
    const text = lines.join('\n').trimEnd();
    return { ok: true, length: text.length, text };
  }

  async merge(id) {
    const p = this.get(id);
    if (!p || p.status !== 'pending') return { ok: false, code: 'state', error: 'Предложение уже обработано' };
    if (p.marker.op !== 'update') return { ok: false, code: 'state', error: 'Merge доступен только для обновления файла' };
    const project = this.store.getProjectForChat(p.chatId);
    if (!project) return { ok: false, code: 'no-project', error: 'Чат не привязан к проекту' };
    const target = p.override || p.marker;
    const stripped = await stripRootPrefix(project.path, target.path);
    const rr = await resolveInProject(project.path, stripped || target.path);
    if (!rr.ok || !rr.exists) return { ok: false, code: 'missing', error: 'Файл не найден' };
    const manual = await this._manualBase(project.id, rr.rel);
    if (!manual) return { ok: false, code: 'no-manual', error: 'Последняя версия Whale Bridge совпадает с диском — merge не нужен' };
    const base = (await fs.readFile(path.join(this.store.backupDir, manual.history.id + '.after'), 'utf8').catch(() => null))?.replace(/^\uFEFF/, '');
    if (base == null) return { ok: false, code: 'no-base', error: 'Базовая копия последней операции недоступна' };
    let theirs = p.content;
    if (p.mode === 'patch') {
      if (p.patchIssues.length || p.patchOpen || !p.edits.length) return { ok: false, code: 'patch-failed', error: 'Предложение нельзя применить к базовой версии: проверьте SEARCH/REPLACE' };
      const applied = applyEdits(base, p.edits);
      if (!applied.ok) return { ok: false, code: 'patch-failed', error: applied.error };
      theirs = applied.text;
    }
    const ours = (await fileops.readTextFile(manual.abs)).text;
    const merged = merge3(base, ours, theirs);
    if (!merged.ok) {
      const conflictOps = diffLines(ours, theirs);
      return { ok: false, code: 'merge-conflict', conflicts: merged.conflicts, mergedText: merged.text,
        conflictRows: toRows(conflictOps, 3), conflictStats: diffStats(conflictOps) };
    }
    const opId = crypto.randomUUID();
    const res = await fileops.applyChange({ root: project.path, rel: rr.rel, op: 'update', newText: merged.text, expectedHash: manual.current.hash,
      expectedNewHash: null, createDirs: false, backupDir: this.store.backupDir, opId, trash: this.trash });
    if (!res.ok) return res;
    await this.store.addHistory({ id: opId, ts: Date.now(), chatId: p.chatId, projectId: project.id, projectName: project.name,
      relPath: rr.rel, op: 'update', newRelPath: null, status: 'applied', beforeHash: res.beforeHash, afterHash: res.afterHash,
      error: null, merged: true, mergeBaseHistoryId: manual.history.id });
    await this.store.pruneFile(project.id, rr.rel, MAX_BACKUPS_PER_FILE).catch((e) => console.error('[prune]', e));
    p.status = 'applied'; p.historyId = opId; this.onChange();
    return { ok: true, historyId: opId };
  }

  /**
   * Откат операции. Сам откат попадает в журнал (source: 'rollback'), но повторно откатить
   * его НЕЛЬЗЯ: резервные копии для него не создаются — иначе каждый откат удваивал бы число
   * файлов в backups/, а цепочка «откат отката» только путает. Записей об откате хранится
   * не больше ROLLBACK_RECORD_LIMIT на файл.
   */
  /**
   * Пользователь подтвердил: модель проинформирована о текущей версии файла.
   * Отметка снимется сама при следующем изменении — сравнивается хэш, а не флаг.
   */
  /**
   * Пользователь подтвердил: модель проинформирована о текущей версии файла.
   * Отметка снимется сама при следующем изменении — сравнивается хэш, а не флаг.
   */
  /**
   * Страховка перед перезаписью файла.
   *
   * Журнал может знать версию только по хэшу: так получалось у записей, созданных до
   * появления снимков, и у перенесённых миграцией. Пока эта версия лежит на диске, её
   * содержимое ещё можно сохранить; через мгновение файл перезапишут — и сравнение
   * «версия модели -> диск» останется без второй стороны навсегда. Поэтому вызов
   * происходит непосредственно перед записью.
   *
   * @param {string} hash хэш из fileops.readTextFile — по сырым байтам, пересчитывать
   *   его от text нельзя: у файла с BOM или CRLF значения не совпадут
   * @returns {Promise<boolean>} true — снимок досоздан
   */
  async ensureContextSnapshot(chatId, projectId, relPath, hash, text) {
    if (!chatId || !relPath || typeof hash !== 'string' || !hash || typeof text !== 'string') return false;
    const known = this.store.contextKnown();
    const e = Context.knownVersion(known, chatId, projectId, relPath);
    if (!e || e.hash !== hash) return false; // журнал знает другую версию — её содержимого здесь нет
    if (await this.store.readContextSnapshot(hash) != null) return false; // уже есть
    return !!(await this.store.saveContextSnapshot(hash, text));
  }

  async ackContext(chatId, projectId, relPath) {
    if (!chatId) return { ok: false, error: 'Чат не открыт: некому адресовать отметку' };
    const project = this.store.getProject(projectId);
    if (!project) return { ok: false, error: 'Проект не найден' };
    const r = await resolveInProject(project.path, relPath);
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.exists || !r.isFile) return { ok: false, error: 'Файл не найден' };
    // readTextFile, а не readRawFile: хэш тот же (по байтам), но файл в не-UTF-8 подтвердить
    // нельзя — его содержимое всё равно не передать модели, и отметка вводила бы в заблуждение.
    const cur = await fileops.readTextFile(r.abs);
    if (cur.error) return { ok: false, error: cur.error };
    Context.record(this.store.contextKnown(), chatId, {
      projectId: project.id, relPath: r.rel, hash: cur.hash, source: 'ack',
    });
    await this.store.saveContextSnapshot(cur.hash, cur.text);
    await this.store.saveContext();
    this.onChange();
    return { ok: true, relPath: r.rel, hash: cur.hash };
  }

  /** Подтвердить сразу все файлы с расхождением — чтобы не кликать по каждому. */
  async ackAllDivergent(chatId, projectId) {
    const { items } = await this.listDivergences(chatId, projectId);
    let ok = 0;
    const failed = [];
    for (const item of items) {
      const r = await this.ackContext(chatId, projectId, item.relPath);
      if (r.ok) ok++;
      else failed.push(`${item.relPath}: ${r.error}`);
    }
    return { ok: failed.length === 0, acked: ok, total: items.length, failed };
  }

  /** Какая версия файлов известна модели — для отметок в дереве и статусе редактора. */
  contextKnownHashes(chatId, projectId, rels) {
    return Context.knownHashes(this.store.contextKnown(), chatId, projectId, rels);
  }

  /**
   * Фиксирует, что перечисленные версии файлов переданы модели (например, скопированы
   * в промпт как контекст). Пакетом — чтобы не писать конфиг на каждый файл.
   * @param files {[{relPath:string, hash:string, content?:string}]} content нужен для снимка
   */
  async recordContext(chatId, projectId, files, source) {
    if (!chatId || !projectId || !Array.isArray(files)) return 0;
    let n = 0;
    for (const f of files) {
      if (!f || typeof f.relPath !== 'string' || !f.relPath) continue;
      if (typeof f.hash !== 'string' || !f.hash) continue;
      if (!Context.record(this.store.contextKnown(), chatId, { projectId, relPath: f.relPath, hash: f.hash, source })) continue;
      if (typeof f.content === 'string') await this.store.saveContextSnapshot(f.hash, f.content);
      n++;
    }
    if (n) {
      await this.store.saveContext();
      this.onChange();
    }
    return n;
  }

  async historyRevert(id, force) {
    const h = this.store.getHistory(id);
    if (!h || h.status !== 'applied') return { ok: false, code: 'state', error: 'Эту операцию нельзя откатить' };
    if (h.revertible === false || h.source === 'rollback') {
      return { ok: false, code: 'not-revertible', error: 'Это запись об откате — повторно откатить её нельзя' };
    }
    const project = this.store.getProject(h.projectId);
    if (!project) return { ok: false, code: 'state', error: 'Проект удалён из списка' };
    if (h.pruned && h.op !== 'create') {
      return { ok: false, code: 'pruned', error: 'Резервная копия этой операции удалена (хранятся 2 последние версии файла)' };
    }
    // До перемещения файл лежит в newRelPath, после отката — снова в relPath
    const beforeHash = await this._hashAt(project.path, h.op === 'move' ? h.newRelPath : h.relPath);
    const res = await fileops.restore({
      root: project.path, rel: h.relPath, op: h.op, newRel: h.newRelPath, backupDir: this.store.backupDir,
      opId: h.id, afterHash: h.afterHash, force: !!force,
    });
    if (!res.ok) return res;

    await this.store.updateHistory(id, { status: 'reverted', revertedAt: Date.now() });
    const afterHash = await this._hashAt(project.path, h.relPath);
    await this.store.addHistory({
      id: crypto.randomUUID(), ts: Date.now(), chatId: h.chatId ?? null,
      projectId: h.projectId, projectName: h.projectName,
      relPath: h.relPath, op: h.op, newRelPath: h.newRelPath || null,
      status: 'applied', source: 'rollback', revertible: false, revertedHistoryId: h.id,
      beforeHash, afterHash, error: null,
      pruned: true, // резервных копий нет — Diff и повторный откат недоступны
    });
    await this.store.pruneRollbackRecords(h.projectId, h.relPath).catch((e) => console.error('[rollback prune]', e));
    this.onChange();
    return res;
  }
}

module.exports = { ProposalManager };
