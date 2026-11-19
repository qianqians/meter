// 期望输出：imports-field-ok
// 验证：node app.mjs
//
// 这说明 `package.json#imports` 的 `#core/*` 别名由 **运行时本身**解析（Node 18.20.8 实测），
// 不需要 tsconfig 的 `paths`、不需要打包器插件、也不需要给 tsc 额外配置。
// 对 monorepo（core / adapter-cocos / app）而言，这一条能替掉一大片路径配置。
import { hello } from '#core/x.mjs';

console.log(hello());
