'use strict';
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { parseBlock } = require('./parser');
const { resolveInProject, normalizeRel } = require('./paths');
const { diffLines, diffStats, toRows } = require('./diff');
const fileops = require('./fileops');
const { ABSENT, classifyVersions } = require('./versions');
const Context = require('./context');
const editorfs = require('./editorfs');
const { applyEdits } = require('./patch');

const MAX_BACKUPS_PER_FILE = 2;
// Сколько файлов журнала проверяем за один запрос: проверка требует чтения каждого.
// Совпадает с внутренним лимитом editorfs.hashesForEditor.
const MAX_DIVERGENCE_CHECK = 200;

const MAX_ROWS = 4000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);
const countLines = (t) => (t === '' ? 0 : t.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length);
const linesOf = (t) => (t === '' ? [] : t.replace(/\r\n?/g, '\n').split('\n').filter((x, i, a) => !(i === a.length - 1 && x === '')));

function diffChanges(base, other) {
  const ops = diffLines(base, other);
  if (ops == null) return null;
  const out = []; let baseIndex = 0;
  for (let i = 0; i < ops.length;) {
    if (ops[i].type === 'eq') { baseIndex += linesOf(ops[i].text).length; i++; continue; }
    const start = baseIndex; let oldCount = 0; const replacement = [];
    while (i < ops.length && ops[i].type !== 'eq') {
      if (ops[i].type === 'del') oldCount += linesOf(ops[i].text).length;
      else replacement.push(...linesOf(ops[i].text));
      i++;
    }
    out.push({ start, end: start + oldCount, replacement });
    baseIndex += oldCount;
  }
  return out;
}

function merge3(base, ours, theirs) {
  const a = diffChanges(base, ours), b = diffChanges(base, theirs);
  if (!a || !b) return { ok: false, conflicts: 1, text: null };
  const changes = [...a.map((x) => ({ ...x, side: 'ours' })), ...b.map((x) => ({ ...x, side: 'theirs' }))]
    .sort((x, y) => x.start - y.start || x.end - y.end || (x.side === 'ours' ? -1 : 1));
  const groups = [];
  for (const ch of changes) {
    const last = groups.at(-1);
    const overlap = last && last.some((x) =>
      (x.start === x.end && ch.start === ch.end && x.start === ch.start) ||
      (x.start < ch.end && ch.start < x.end) ||
      (x.start === x.end && x.start > ch.start && x.start < ch.end) ||
      (ch.start === ch.end && ch.start > x.start && ch.start < x.end));
    if (overlap) last.push(ch); else groups.push([ch]);
  }
  const accepted = [], conflicts = [];
  for (const group of groups) {
    const ours = group.filter((x) => x.side === 'ours'), theirs = group.filter((x) => x.side === 'theirs');
    if (!ours.length || !theirs.length) { accepted.push(group[0]); continue; }
    if (ours.length === 1 && theirs.length === 1 &&
        ours[0].start === theirs[0].start && ours[0].end === theirs[0].end &&
        ours[0].replacement.join('\n') === theirs[0].replacement.join('\n')) { accepted.push(ours[0]); continue; }
    conflicts.push({ start: Math.min(...group.map((x) => x.start)), end: Math.max(...group.map((x) => x.end)),
      ours: ours.map((x) => x.replacement.join('\n')).join('\n'),
      theirs: theirs.map((x) => x.replacement.join('\n')).join('\n') });
  }
  const baseLines = linesOf(base);
  const all = [...accepted.map((x) => ({ ...x, kind: 'ok' })), ...conflicts.map((x) => ({ ...x, kind: 'conflict' }))]
    .sort((x, y) => x.start - y.start || x.end - y.end);
  const out = []; let pos = 0;
  for (const ch of all) {
    if (ch.start > pos) out.push(...baseLines.slice(pos, ch.start));
    if (ch.kind === 'ok') out.push(...ch.replacement);
    else {
      out.push('<<<<<<< YOUR CURRENT FILE');
      if (ch.ours) out.push(...linesOf(ch.ours));
      out.push('=======');
      if (ch.theirs) out.push(...linesOf(ch.theirs));
      out.push('>>>>>>> AI PROPOSAL');
    }
    pos = Math.max(pos, ch.end);
  }
  if (pos < baseLines.length) out.push(...baseLines.slice(pos));
  return { ok: conflicts.length === 0, conflicts: conflicts.length, text: out.join('\n') + (base.endsWith('\n') ? '\n' : '') };
}

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
    return {
      ...ev,
      rows: rows.slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
      newText: ev.newText ?? null, // итоговый файл (для патча — после применения блоков)
      rawText: p.content, // как прислал ИИ
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
      await this.store.saveContext().catch((e) => console.error('[context]', e));
    }
    p.status = 'applied';
    p.historyId = opId;
    await this.store.setProposalDecision(p.chatId, p.contentHash, 'applied', opId);
    this.onChange();
    return { ok: true, historyId: opId };
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
    return { ...h, rows: toRows(ops, 3).slice(0, MAX_ROWS), stats: diffStats(ops) };
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

  async manualView(chatId, projectId, relPath) {
    const div = await this._divergence(chatId, projectId, relPath);
    const manual = await this._manualBase(projectId, relPath);
    if (!manual) {
      // Сравнение построить нечем (нет резервной копии), но расхождение есть — сообщаем о нём
      if (!div.diverged) return null;
      return {
        relPath, historyId: null, noBase: true, diverged: true,
        knownVersion: {
          hash: div.known.hash, source: div.known.source, ts: div.known.ts,
          label: Context.SOURCE_LABEL[div.known.source] || div.known.source,
        },
        error: 'Резервной копии версии, которую видела модель, нет — построчное сравнение недоступно. Скопируйте актуальную версию и передайте модели.',
      };
    }
    if (manual.hashOnly) {
      return {
        relPath, historyId: manual.history.id, hashOnly: true,
        diverged: div.diverged,
        knownVersion: div.known ? {
          hash: div.known.hash, source: div.known.source, ts: div.known.ts,
          label: Context.SOURCE_LABEL[div.known.source] || div.known.source,
        } : null,
        error: 'Последняя операция над файлом — откат. Резервная копия для отката не хранится (откат неоткатим), поэтому построчное сравнение недоступно.',
      };
    }
    const after = await fs.readFile(path.join(this.store.backupDir, manual.history.id + '.after'), 'utf8').catch(() => null);
    if (after == null) return null;
    const current = await fileops.readTextFile(manual.abs);
    if (current.error) return { relPath, historyId: manual.history.id, error: current.error };
    const baseText = after.replace(/^\uFEFF/, '');
    const ops = diffLines(baseText, current.text), rows = toRows(ops, 3);
    return { relPath, historyId: manual.history.id, afterHash: manual.history.afterHash, currentHash: manual.current.hash,
      diverged: div.diverged,
      knownVersion: div.known ? {
        hash: div.known.hash, source: div.known.source, ts: div.known.ts,
        label: Context.SOURCE_LABEL[div.known.source] || div.known.source,
      } : null,
      stats: diffStats(ops), rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS, currentText: current.text };
  }

  /**
   * Копирует текущие версии файлов, о которых модель знает устаревшее.
   *
   * Копирование фиксируется в журнале (source: 'manual-copy'): содержимое уходит в буфер
   * обмена именно для того, чтобы попасть в чат. Компромисс сознательный — если пользователь
   * скопировал и не отправил, отметка окажется преждевременной, но вред ограничен: она
   * скроет расхождение только до следующего изменения файла, а любая новая правка снова
   * его покажет. Обратная ошибка (требовать подтверждения на каждое копирование) дороже.
   */
  async copyDivergentVersions(chatId, projectId) {
    const { items } = await this.listDivergences(chatId, projectId);
    if (!items.length) return { ok: false, error: 'Расхождений нет: модель знает текущие версии всех отслеживаемых файлов' };
    const project = this.store.getProject(projectId);
    if (!project) return { ok: false, error: 'Проект не найден' };
    const parts = ['Эти файлы изменились после того, как ты видела их последнюю версию. Считай актуальной версию ниже.'];
    const copied = [];
    for (const item of items) {
      const r = await resolveInProject(project.path, item.relPath);
      if (!r.ok || !r.exists || !r.isFile) continue;
      const cur = await fileops.readTextFile(r.abs);
      if (cur.error) continue; // не-UTF-8 модели передать всё равно нельзя
      parts.push(`--- ${item.relPath} ---\n${cur.text}`);
      copied.push({ relPath: item.relPath, hash: cur.hash });
    }
    if (!copied.length) return { ok: false, error: 'Ни один из файлов с расхождением не удалось прочитать как текст' };
    for (const c of copied) {
      Context.record(this.store.contextKnown(), chatId, {
        projectId, relPath: c.relPath, hash: c.hash, source: 'manual-copy',
      });
    }
    await this.store.saveContext();
    this.onChange();
    const text = parts.join('\n\n');
    return { ok: true, length: text.length, files: copied.length, text };
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
   * @param files {[{relPath:string, hash:string}]}
   */
  async recordContext(chatId, projectId, files, source) {
    if (!chatId || !projectId || !Array.isArray(files)) return 0;
    let n = 0;
    for (const f of files) {
      if (!f || typeof f.relPath !== 'string' || !f.relPath) continue;
      if (typeof f.hash !== 'string' || !f.hash) continue;
      if (Context.record(this.store.contextKnown(), chatId, { projectId, relPath: f.relPath, hash: f.hash, source })) n++;
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
