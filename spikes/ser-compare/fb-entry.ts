// esbuild 的打包入口：把 flatc 生成的 TS 与 flatbuffers 运行时打成一份 ESM
export { StatePacket } from './gen/ts/s2/state-packet.js';
export { StatePacketSoA } from './gen/ts/s2/state-packet-so-a.js';
export { EntityState } from './gen/ts/s2/entity-state.js';
export { Builder, ByteBuffer } from 'flatbuffers';
