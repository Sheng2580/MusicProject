# 本地内置音频说明



## See You Again

- 文件：`see-you-again-full.mp3`
- 原曲完整标题：See You Again (feat. Charlie Puth)
- 演唱：Wiz Khalifa feat. Charlie Puth
- 专辑：Furious 7 (Original Motion Picture Soundtrack)
- Apple 曲目 ID：`966411602`
- [Apple Music 曲目页面](https://music.apple.com/us/album/see-you-again-feat-charlie-puth/966411595?i=966411602)
- 本地文件：9,239,467 字节，约 **229.564082 秒**，44,100 Hz，双声道 MP3，320 kbps。
- SHA-256：`941d1cf77fda45521f453972c38f51a3288a022402902d925689465d754d5a78`
- 无人声轨：`see-you-again-backing.m4a`，7,555,273 字节，229.564082 秒，44,100 Hz，双声道 AAC，约 262 kbps。
- 无人声轨 SHA-256：`1d29df60ef8577d066a39affde2371f4e3b31639702f6c8194448eb1c277b2b0`

## 小美满

- 文件：`xiao-mei-man-full.mp3`
- 原曲完整标题：小美满（电影《热辣滚烫》热辣陪伴曲）
- 演唱：周深
- Apple 曲目 ID：`1733140195`
- [Apple Music 中文曲目页面](https://music.apple.com/tw/song/1733140195)
- 本地文件：8,962,528 字节，约 **214.248000 秒**，48,000 Hz，双声道 MP3，320 kbps。
- SHA-256：`417b17b693d6ed8f266484d29e48d8988659c59d3c6607c8c635226cc4fe8348`
- 无人声轨：`xiao-mei-man-backing.m4a`，7,096,816 字节，214.248005 秒，44,100 Hz，双声道 AAC，约 263 kbps。
- 无人声轨 SHA-256：`f7425c7b63ba4fe09c4231b829a554aa0ed9128653677c96beef87164e49fae7`
- 美国目录将同一曲目列为 “Little Joys (Interlude Song from Motion Picture \"Yolo\")”，演唱者 “Zhou Shen”；台湾目录以中文标题及周深署名确认了同一曲目 ID。当前文件是周深演唱版，不是伴奏版。

## 无人声轨处理

两份 `backing.m4a` 都由对应的本地原曲通过开源 Demucs 4.1 `htdemucs` 模型做 vocals / no-vocals 双轨分离，再以 CoreAudio 转为约 256 kbps AAC。它们没有从外部站点下载，也没有改变原 MP3。应用只在内置曲目中读取这些本地结果；读取或解码失败时会回退到本机合成伴奏。

## 验证

实际时长、采样率、码率与格式使用 macOS `file`、`afinfo` 和 CoreAudio 回解核实。曲目清单在 `tracks.json`；`version` 字段用于把浏览器 IndexedDB 中旧版分析缓存一次性升级为当前旋律和伴奏资源。
