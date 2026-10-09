'use strict';
// Операции пользователя над файлами из дерева проекта (этап D): создать, переименовать,
// удалить файл или папку — не выходя из IDE, как в обычном редакторе кода.
//
// Правила те же, что у редактора (src/editorfs.js): содержимое файлов попадает на диск
// ТОЛЬКО через fileops.applyChange — с атомарной записью, резервной копией и записью в
// историю. Поэтому созданный/удалённый/переименованный файл откатывается из «Истории»
// так же, как операция приложения, а удаление всегда идёт через системную корзину.
//
// Папки содержимого не имеют: их операции выполняет fileops (createDir/renameDir/deleteDir),
// в историю они не пишутся — восстанавливать папку из корзины достаточно.
//
// Журнал контекста при переименовании переносится (Context.renamePaths + базовые снимки):
// знание модели привязано к содержимому, а переименование содержимое не меняет. Без
// переноса каждое переименование давало бы два ложных сигнала — «файл пропал» по старому
// пути и «новый файл» по новому. При удалении записи журнала НЕ трогаются: «модель знает
// версию файла, которого больше нет» — честный сигнал расхождения, его показывает список.
//
// Модуль не зависит от Electron: корзина внедряется функцией trash (main передаёт
// shell.trashItem), поэтому все сценарии покрыты node-тестами.

const crypto = require('crypto');
const { resolveInProject } = require('./paths');
const fileops = require('./fileops');
const Context = require('./context');

// Тот же лимит, что у editorfs: 2 последние версии файла
const MAX_BACKUPS_PER_FILE = 2;

const fail = (code, error) => ({ ok: false, code, error });

/**
 * Создать пустой файл. Путь может содержать несуществующие папки («папка/файл.txt»
 * из поля ввода) — они создаются вместе с файлом. Запись через applyChange op:'create':
 * атомарно, с отказом, если файл появился на диске между проверкой и записью.
 * Модель созданный файл НЕ знает: отметка «знает» ставится только явным действием,
 * поэтому файл сразу подсветится как новый (список unseen).
 */
async function createFile({ project, rel, store, chatId = null }) {
  if (!project) return fail('no-project', 'Проект не выбран');
  const r = await resolveInProject(project.path, rel);
  if (!r.ok) return fail('path', r.error);
  if (r.exists) return fail('exists', r.isFile ? 'Файл уже существует' : 'Папка с таким именем уже существует');
  const opId = crypto.randomUUID();
  const res = await fileops.applyChange({
    root: project.path, rel: r.rel, op: 'create', newText: '',
    createDirs: true, backupDir: store.backupDir, opId,
  });
  if (!res.ok) return res;
  await store.addHistory({
    id: opId, ts: Date.now(), chatId, projectId: project.id, projectName: project.name,
    relPath: r.rel, op: 'create', newRelPath: null,
    status: 'applied', beforeHash: null, afterHash: res.afterHash, error: null,
    source: 'manual', // §10: операцию выполнил пользователь, не модель
  });
  await store.pruneFile(project.id, r.rel, MAX_BACKUPS_PER_FILE).catch((e) => console.error('[prune]', e));
  return { ok: true, rel: r.rel, isDir: false, hash: res.afterHash, historyId: opId };
}

/** Создать папку (вместе с промежуточными). В историю не пишется: содержимого нет. */
async function createDir({ project, rel }) {
  if (!project) return fail('no-project', 'Проект не выбран');
  return fileops.createDir(project.path, rel);
}

/**
 * Переименовать/переместить файл или папку (в пределах проекта).
 *
 * Файл — через applyChange op:'move': резервные копии обеих сторон, проверка хэша
 * (файл не должен измениться между показом дерева и операцией), запись в историю —
 * откат из «Истории» возвращает прежнее имя. Папка — fs.rename внутри fileops.
 * В обоих случаях записи журнала контекста и базовых снимков переезжают на новый путь.
 */
async function renamePath({ project, rel, newRel, store, chatId = null }) {
  if (!project) return fail('no-project', 'Проект не выбран');
  const r = await resolveInProject(project.path, rel);
  if (!r.ok) return fail('path', r.error);
  if (!r.exists) return fail('missing', 'Файл или папка не найдены');
  const dest = await resolveInProject(project.path, newRel);
  if (!dest.ok) return fail('path', dest.error);
  if (dest.exists) return fail('exists', 'Файл или папка назначения уже существует');
  if (dest.rel === r.rel) return fail('exists', 'Новый путь совпадает со старым');

  if (!r.isFile) {
    const res = await fileops.renameDir(project.path, r.rel, dest.rel);
    if (!res.ok) return res;
    await rekeyJournals({ store, projectId: project.id, fromRel: r.rel, toRel: res.newRel });
    return { ok: true, rel: r.rel, newRel: res.newRel, isDir: true };
  }

  const cur = await fileops.readRawFile(r.abs);
  if (cur.error) return fail('io', cur.error);
  const opId = crypto.randomUUID();
  const res = await fileops.applyChange({
    root: project.path, rel: r.rel, op: 'move', newRel: dest.rel,
    expectedHash: cur.hash, expectedNewHash: 'absent', createDirs: true,
    backupDir: store.backupDir, opId,
  });
  if (!res.ok) return res;
  await store.addHistory({
    id: opId, ts: Date.now(), chatId, projectId: project.id, projectName: project.name,
    relPath: r.rel, op: 'move', newRelPath: res.newRel,
    status: 'applied', beforeHash: res.beforeHash, afterHash: res.afterHash, error: null,
    source: 'manual',
  });
  await store.pruneFile(project.id, r.rel, MAX_BACKUPS_PER_FILE).catch((e) => console.error('[prune]', e));
  await rekeyJournals({ store, projectId: project.id, fromRel: r.rel, toRel: res.newRel });
  return { ok: true, rel: r.rel, newRel: res.newRel, isDir: false, hash: res.afterHash, historyId: opId };
}

/**
 * Удалить файл или папку — всегда в системную корзину.
 *
 * Файл: applyChange op:'delete' с проверкой хэша и резервной копией — откат из
 * «Истории» восстанавливает содержимое даже мимо корзины. Папка: целиком в корзину;
 * в историю не пишется (её содержимое приложению не принадлежит — копии чужих файлов
 * мы не делали), восстановление — из корзины.
 */
async function deletePath({ project, rel, store, chatId = null, trash }) {
  if (!project) return fail('no-project', 'Проект не выбран');
  const r = await resolveInProject(project.path, rel);
  if (!r.ok) return fail('path', r.error);
  if (!r.exists) return fail('missing', 'Файл или папка не найдены');

  if (!r.isFile) {
    return fileops.deleteDir(project.path, r.rel, trash);
  }

  const cur = await fileops.readRawFile(r.abs);
  if (cur.error) return fail('io', cur.error);
  const opId = crypto.randomUUID();
  const res = await fileops.applyChange({
    root: project.path, rel: r.rel, op: 'delete',
    expectedHash: cur.hash, createDirs: false, backupDir: store.backupDir, opId, trash,
  });
  if (!res.ok) return res;
  await store.addHistory({
    id: opId, ts: Date.now(), chatId, projectId: project.id, projectName: project.name,
    relPath: r.rel, op: 'delete', newRelPath: null,
    status: 'applied', beforeHash: res.beforeHash, afterHash: null, error: null,
    source: 'manual',
  });
  await store.pruneFile(project.id, r.rel, MAX_BACKUPS_PER_FILE).catch((e) => console.error('[prune]', e));
  return { ok: true, rel: r.rel, isDir: false, historyId: opId };
}

/** После переименования: записи журнала знания и базовых снимков переезжают на новый путь. */
async function rekeyJournals({ store, projectId, fromRel, toRel }) {
  const moved = Context.renamePaths(store.contextKnown(), projectId, fromRel, toRel);
  if (moved) await store.saveContext().catch((e) => console.error('[context]', e));
  await store.renameBaselinePaths(projectId, fromRel, toRel).catch((e) => console.error('[baseline]', e));
  return moved;
}

module.exports = { createFile, createDir, renamePath, deletePath, rekeyJournals, MAX_BACKUPS_PER_FILE };
