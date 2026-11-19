#!/usr/bin/env bash
# 重新生成 S2 的全部产物。生成物不入库（见 .gitignore），只提交 schema 与脚本。
#
# 依赖（一次性）：
#   npm install                                     # protobufjs / flatbuffers / esbuild / protobufjs-cli
#                                                    # + @bufbuild/protobuf, @bufbuild/protoc-gen-es（protobuf-es）
#                                                    # + @mongodb-js/zstd（压缩实验，原生预编译包）
#   tools/flatc.exe   ← https://github.com/google/flatbuffers/releases (Windows.flatc.binary.zip)
#   tools/protoc/bin/protoc.exe ← https://github.com/protocolbuffers/protobuf/releases (protoc-*-win64.zip)
#   protoc-gen-go     ← go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
#   Go 模块（离线环境需要 GOSUMDB=off / GOPROXY 可用）：
#     go get github.com/google/flatbuffers/go google.golang.org/protobuf
set -euo pipefail

./tools/flatc.exe --ts -o gen/ts schema/state.fbs
./tools/flatc.exe --go -o gen/go schema/state.fbs
./tools/flatc.exe --ts -o gen/ts schema/fb-evolution.fbs

./node_modules/.bin/pbjs -t static-module -w commonjs -o gen/ts/pb_static.cjs schema/state.proto

# gen/ 不入库，所以打包入口放在仓库里（fb-entry.ts），它 import 的是 gen/ts 下的生成码
./node_modules/.bin/esbuild fb-entry.ts --bundle --format=esm --platform=node --outfile=gen/js/fb.mjs --resolve-extensions=.ts,.js
./node_modules/.bin/esbuild fb2-entry.ts --bundle --format=esm --platform=node --outfile=gen/js/fb2.mjs --resolve-extensions=.ts,.js

./tools/protoc/bin/protoc.exe \
  --plugin=protoc-gen-go="$(go env GOPATH)/bin/protoc-gen-go.exe" \
  --go_out=. --go_opt=paths=source_relative -I schema schema/state.proto
mv state.pb.go schema/state.pb.go

go build -o bench-go.exe ./bench-go
echo "OK: gen/ 已生成，bench-go.exe 已构建"
