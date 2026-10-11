# Three.js 离线依赖来源

本目录仅包含棋盘展示需要的 Three.js r160 模块与 OrbitControls。通过静态文件白名单提供 JavaScript，运行时不使用 CDN、外部字体或网络模型资产。

| 文件 | 来源及修改 |
| --- | --- |
| `three.module.js` | 复制自用户授权参考项目 `D:\wjz\projects\xq\xq\vendor\three\build\three.module.js`，r160，内容未修改 |
| `OrbitControls.js` | 复制自同一参考项目 `vendor\three\examples\jsm\controls\OrbitControls.js`；只将 `from 'three'` 改为 `from './three.module.js'` |
| `LICENSE.txt` | Three.js MIT 许可，保留作者版权声明 |

上游原始版本：[Three.js r160](https://github.com/mrdoob/three.js/tree/r160)、[MIT 许可](https://github.com/mrdoob/three.js/blob/r160/LICENSE)。参考项目仅被读取，未被修改。

复制后文件的 SHA-256：

```text
three.module.js  76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495
OrbitControls.js 6b2f7df940a94e9aefe48466d8722c882e1430072c1dd680e978e0d70527ff00
```

棋盘、棋子、中文纹理和交互控制器是本竞技场的新实现；参考项目还提供了十种快捷表情的图标与中文名称。
