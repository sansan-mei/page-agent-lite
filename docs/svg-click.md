# SVG 图标点击兼容

点击命中当前快照目标内部的 SVG/path 等元素时，没有原生 click 方法则派发一次冒泡 MouseEvent。保留实际命中元素作为事件目标，已有原生 click 方法的元素沿用原路径。遮挡和交互期间目标变化检查保持有效。

合成事件不等于受信任输入，也不保证视频切换；页面变化仍需独立核对。参见 [网页工具协议](browser-tools.md)。

上游对照：alibaba/page-agent 的 `d8dd334487cb2de14206aa8ca939a1613cd612dc` 中 `packages/page-controller/src/actions.ts` 仅在命中 HTMLElement 且属于目标时采用命中对象，否则回退原 HTMLElement，再调用 click。本项目采用 SVG 命中对象派发 MouseEvent 的路径，保留实际命中与已有遮挡保护。上游滚动有向祖先查找及页面启发式容器回退，但代码已标注页面启发式不可靠；本次未引入自动切换容器。
