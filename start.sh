#!/usr/bin/env sh
# Linux / macOS: установит зависимости при необходимости и запустит приложение
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js не найден. Установите LTS с https://nodejs.org"; exit 1; }
if [ ! -d node_modules/electron ] || ! cmp -s package.json node_modules/.package.stamp; then
  echo "Установка зависимостей (только при первом запуске или после обновления)..."
  npm install --no-audit --no-fund || exit 1
  cp package.json node_modules/.package.stamp
fi
exec ./node_modules/.bin/electron .
