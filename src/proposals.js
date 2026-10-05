'use strict';
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { parseBlock } = require('./parser');
const { resolveInProject, normalizeRel } = require('./paths');
const { diffLines, diffStats, toRows } = require('./diff');
const fileops = require('./fileops');
const { applyEdits } = require('./patch');

const MAX_BACKUPS_PER_FILE = 2;

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
          });
          this.hashes.add(`${chatId}:${hash}`);
          changed = true;
          continue;
        }
      }
      if (this.hashes.has(`${chatId}:${hash}`)) continue;

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
        status: 'pending', // pending | applied | rejected
        historical: !!b.initial,
        override: null,
        dismissed: false,
        historyId: null,
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

  get(id) { return this.map.get(id) || null; }

  async evaluate(p) {
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
      return { ...out, state: 'move', stats: { added: 0, removed: 0 }, baseHash: cur.hash, newText: decoded.error ? null : decoded.text, encodingWarning: decoded.error || null, expectedNewHash: 'absent', needsDirs: !dest.parentExists };
    }

    if (target.op === 'update') {
      if (!r.exists || !r.isFile) {
        out.suggestions = await fileops.suggestPaths(project.path, r.rel);
        return { ...out, state: 'missing' };
      }
      const cur = await fileops.readTextFile(r.abs);
      if (cur.error) return { ...out, state: 'unreadable', error: cur.error };
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
    return { ...out, state: 'create', ops, stats: diffStats(ops), baseHash: 'absent', needsDirs: !r.parentExists, newText: p.content };
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
      this.onChange();
    }
  }

  dismissAll(chatId, includeHistorical) {
    for (const p of this.map.values()) {
      if (p.chatId !== chatId || p.dismissed) continue;
      if (p.historical && p.status === 'pending' && !includeHistorical) continue;
      p.dismissed = true;
    }
    this.onChange();
  }

  reject(id) {
    const p = this.get(id);
    if (p && p.status === 'pending') {
      p.status = 'rejected';
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
      if (res.code === 'io') await this.store.addHistory({ ...base, status: 'failed', error: res.error });
      return res;
    }
    await this.store.addHistory({
      ...base, status: 'applied', beforeHash: res.beforeHash, afterHash: res.afterHash, error: null,
    });
    await this.store.pruneFile(project.id, ev.relPath, MAX_BACKUPS_PER_FILE).catch((e) => console.error('[prune]', e));
    p.status = 'applied';
    p.historyId = opId;
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

  async historyRevert(id, force) {
    const h = this.store.getHistory(id);
    if (!h || h.status !== 'applied') return { ok: false, code: 'state', error: 'Эту операцию нельзя откатить' };
    const project = this.store.getProject(h.projectId);
    if (!project) return { ok: false, code: 'state', error: 'Проект удалён из списка' };
    if (h.pruned && h.op !== 'create') {
      return { ok: false, code: 'pruned', error: 'Резервная копия этой операции удалена (хранятся 2 последние версии файла)' };
    }
    const res = await fileops.restore({
      root: project.path, rel: h.relPath, op: h.op, newRel: h.newRelPath, backupDir: this.store.backupDir,
      opId: h.id, afterHash: h.afterHash, force: !!force,
    });
    if (res.ok) {
      await this.store.updateHistory(id, { status: 'reverted', revertedAt: Date.now() });
      this.onChange();
    }
    return res;
  }
}

module.exports = { ProposalManager };
