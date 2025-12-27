# BlueMarble 像素取色（Tampermonkey + 本地HTTP）

本方案使用 Tampermonkey 在页面内计算鼠标所在的像素坐标，
并通过 HTTP POST 发送到本地程序。本地程序根据模板 PNG 和基准坐标，
计算对应像素颜色并输出到控制台。

## 1) 安装 Tampermonkey 脚本

将 `tampermonkey.user.js` 导入到 Tampermonkey，启用脚本后访问：

```
https://wplace.live/
```

## 2) 运行本地程序

在此目录执行：

```
dotnet run -- --template "D:\path\to\template.png" --origin "12,34,100,200"
```

参数说明：
- `--template` 模板 PNG 路径（必填）
- `--origin` 模板左上角基准坐标 `tileX,tileY,pxX,pyY`（必填）
- `--port` 本地监听端口（默认 8787）
- `--poll-ms` 轮询间隔毫秒（默认 100）

未提供 `--template` 或 `--origin` 时会提示输入。

## 3) 输出内容

程序会持续输出：
- 鼠标所在像素格坐标（全局）
- 模板内对应坐标
- RGB 颜色

## 注意事项

- 浏览器脚本默认匹配 `wplace.live` 域名。
- 若地图对象不是 `window.map`，脚本会尝试 `window.wplaceMap`、
  `window.maplibreMap` 或 `window.__map`。
- 你也可以在控制台手动设置：
  `window.__bmPickerMap = <地图对象>`
- 如果你确认对象名不同，可在脚本的 `mapNameOverrides` 中添加。
- 如果仍找不到地图对象，可在控制台运行：
  `window.__bmPickerScan()` 并把输出贴给我，我帮你定位。
- 也可以运行：
  `window.__bmPickerFindMap()` 查找候选 map 路径。
- 如果返回路径（例如 `window.foo.bar.map`），可设置：
  `window.__bmPickerMapPath = "foo.bar.map"`
