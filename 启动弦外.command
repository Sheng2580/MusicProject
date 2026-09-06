#!/bin/zsh

set -u

music_project_dir="${0:A:h}"
music_bundled_node_dir="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin"
music_cowork_node="${HOME}/Library/Application Support/Tuanjie Cowork/bin/node"
music_path_node="$(command -v node 2>/dev/null || true)"
music_node_path=""

if ! cd -- "$music_project_dir"; then
  print -u2 -- "无法打开项目文件夹：$music_project_dir"
  read -r "?按回车键关闭此窗口……"
  exit 1
fi

for music_candidate in "$music_path_node" "$music_cowork_node"; do
  [[ -n "$music_candidate" && -x "$music_candidate" ]] || continue
  music_candidate="${music_candidate:A}"
  [[ "$music_candidate" == "$music_bundled_node_dir/"* ]] && continue
  if "$music_candidate" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1)' >/dev/null 2>&1; then
    music_node_path="$music_candidate"
    break
  fi
done

if [[ -z "$music_node_path" ]]; then
  print -u2 -- "找不到可用的普通 Node.js。请安装标准 Node.js 20.19+ 或 22.12+，然后重新启动。"
  print -u2 -- "此项目不会使用 ChatGPT 应用附带的受限 Node，也不会修改应用签名或系统安全设置。"
  read -r "?按回车键关闭此窗口……"
  exit 1
fi

if [[ ! -d node_modules || ! -f node_modules/vite/bin/vite.js ]]; then
  print -u2 -- "项目依赖尚未安装。请在项目目录完成 pnpm install --frozen-lockfile 后再启动。"
  print -u2 -- "启动器不会自动安装依赖或下载软件。"
  read -r "?按回车键关闭此窗口……"
  exit 1
fi

print -- "正在启动弦外：http://127.0.0.1:5173"
print -- "Node.js：$music_node_path"
print -- "请保留此终端窗口；结束练习后按 Control + C 停止服务。"

"$music_node_path" "$music_project_dir/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port 5173 --strictPort --open
music_exit_code=$?

if (( music_exit_code != 0 )); then
  print -u2 -- "启动未完成（退出码 $music_exit_code）。请查看上方错误；如果 5173 端口已被占用，可先打开 http://127.0.0.1:5173 检查。"
  read -r "?按回车键关闭此窗口……"
fi

exit "$music_exit_code"
