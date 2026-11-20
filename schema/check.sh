#!/usr/bin/env bash
# 框架协议的 codegen + 结构校验。
#
# 生成物去向：
#   gate/internal/pb/    Go 消息（gate 直接编译用）
#   core/src/gen/        TS 消息（逻辑层直接 import）
#   ../.build/           中间产物：descriptor set + 校验用的 bundle（gitignore）
#
# 依赖（一次性，复用 spikes/ser-compare 装好的工具链）：
#   protoc          spikes/ser-compare/tools/protoc/bin/protoc.exe
#   protoc-gen-go   $(go env GOPATH)/bin/protoc-gen-go.exe
#   protoc-gen-es   spikes/ser-compare/node_modules/@bufbuild/protoc-gen-es
#   esbuild         spikes/ser-compare/node_modules/.bin/esbuild
#
# 用法：./check.sh
set -euo pipefail
cd "$(dirname "$0")"

PROTOC=../spikes/ser-compare/tools/protoc/bin/protoc.exe
SC=../spikes/ser-compare
GEN=../.build
LIST="pb/common.proto pb/envelope.proto pb/client.proto pb/gate.proto pb/gate_logic.proto pb/logic_gate.proto pb/logic_logic.proto"
NAMES=(common.proto envelope.proto client.proto gate.proto gate_logic.proto logic_gate.proto logic_logic.proto)

rm -rf "$GEN"
mkdir -p "$GEN" ../core/src/gen ../gate/internal/pb

echo "① protoc 编译 + descriptor set"
"$PROTOC" -I pb --descriptor_set_out="$GEN/fw.desc" --include_imports $LIST

echo "② protoc-gen-go"
"$PROTOC" --plugin=protoc-gen-go="$(go env GOPATH)/bin/protoc-gen-go.exe" \
  --go_out=../gate/internal/pb --go_opt=paths=source_relative -I pb $LIST

echo "③ protoc-gen-es（经 gen-es.mjs 绕开 Windows 上 npm 只给 .cmd 的问题）"
for f in "${NAMES[@]}"; do
  node "$SC/gen-es.mjs" "$GEN/fw.desc" "$f" ../core/src/gen > /dev/null
done

echo "④ 打包（entry 放在 spikes/ser-compare 下，好让 @bufbuild/protobuf 解析到它的 node_modules）"
cat > "$SC/gen/fw-entry.ts" <<'EOF'
export * from '../../../core/src/gen/envelope_pb.js';
export * from '../../../core/src/gen/common_pb.js';
export * from '../../../core/src/gen/client_pb.js';
export * from '../../../core/src/gen/gate_pb.js';
export * from '../../../core/src/gen/logic_gate_pb.js';
export * from '../../../core/src/gen/gate_logic_pb.js';
export * from '../../../core/src/gen/logic_logic_pb.js';
export { create, toBinary, fromBinary } from '@bufbuild/protobuf';
EOF
NODE_PATH="$(cd "$SC/node_modules" && pwd)" "$SC/node_modules/.bin/esbuild" "$SC/gen/fw-entry.ts" \
  --bundle --format=esm --platform=node --outfile="$GEN/fw-bundle.mjs" \
  --resolve-extensions=.ts,.js --log-level=error

echo "⑤ 结构校验"
node verify.mjs

echo
echo "OK: Go $(ls ../gate/internal/pb | wc -l) 个文件（在 gate/internal/pb）/ TS $(ls ../core/src/gen | wc -l) 个文件（在 core/src/gen）/ bundle $(ls -la "$GEN/fw-bundle.mjs" | awk '{print $5}') 字节"
