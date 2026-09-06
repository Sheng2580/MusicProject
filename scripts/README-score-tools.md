# 琴谱解析与校验脚本

这是开发阶段的离线测试工具，不属于玩家流程。玩家在网页中只上传 MP3，
应用会从音频自动生成逐音旋律；这里的机器可读琴谱只作为准确率 oracle，用于发现
漏拍、错音和时间偏移，网页不会要求或接收琴谱文件。

`score_to_melody.py` 把 MIDI、MusicXML、压缩 MusicXML (`.mxl`)、MEI 或 Kern
琴谱转换为弦外可直接读取的旋律 JSON。谱面负责音高和音符顺序；指定原音频时，
音频只用于校准琴谱时间轴，不会反过来用音频转录替换谱面音符。

## GitHub 方案取舍

- [CPJKU/partitura](https://github.com/CPJKU/partitura) 负责读取正式谱面，并保留
  part、voice、staff、速度与反复记号。许可证为 Apache-2.0。
- [groupmm/synctoolbox](https://github.com/groupmm/synctoolbox) 负责默认的
  pitch/chroma、DLNCO onset 和 MrMsDTW 音频对齐。许可证为 MIT。
- [sildater/parangonar](https://github.com/sildater/parangonar) 可作为将来的第二套
  对齐校验，但音频接口仍较新，当前不把它作为唯一基线。
- `craffel/align_midi` 仍是 Python 2 代码，使用已经删除的 librosa API；`TACTUS`
  目前只有基础 DTW 且依赖冲突，所以没有接入。

当前版本要求 Python 3.10 以上，推荐使用 Python 3.11 创建独立环境。先确认
`python3.11` 已安装，再在项目根目录运行：

```sh
python3.11 -m venv .score-venv
.score-venv/bin/pip install -r scripts/requirements-score.txt
```

## 使用流程

先查看琴谱实际包含哪些声部。自动选择会显示候选，但正式生成前应确认 part、voice
和 staff；钢琴谱不能只靠“全谱最高音”可靠地推断人声旋律。

```sh
.score-venv/bin/python scripts/score_to_melody.py inspect song.musicxml
```

指定主旋律声部，并用原曲做高精度时间对齐：

```sh
.score-venv/bin/python scripts/score_to_melody.py convert song.musicxml \
  --part "Voice" --voice 1 --staff 1 \
  --audio public/demo/song.mp3 \
  --compare public/demo/song-old-melody.json \
  --report /tmp/song-score-report.json \
  --output public/demo/song-melody.json
```

`--part` 可以写从 `inspect` 得到的数字索引、part ID 或名称片段。MIDI 文件也可用
同义参数 `--track`。如果谱面和录音不在同一调，默认会检测半音移调并同时修正输出
音高；可用 `--transpose 0` 禁用，或显式写 `--transpose -2`。

没有原音频时，脚本按谱内速度输出秒数：

```sh
.score-venv/bin/python scripts/score_to_melody.py convert song.mid \
  --track 2 --transpose 0 --output /tmp/song-melody.json
```

单独比较两份已有 JSON：

```sh
.score-venv/bin/python scripts/score_to_melody.py compare \
  score-melody.json audio-transcription.json \
  --tolerance 0.25 --report /tmp/compare-report.json
```

候选文件可以是逐音数组、`{"melody": [...]}`，也可以直接使用网页“导出分析”得到的
`{"analysis": {"melody": [...]}}` JSON；不需要手工拆出旋律字段。

报告包含起音覆盖率、候选精确率、完全正确音高率、八度错误、其他错音、起音 MAE/P95、
时值 MAE，以及每个未匹配和已匹配音符的索引。默认 `sync` 对齐器速度较慢但精度高；
快速检查可使用 `--aligner librosa --feature-rate 10`。

## 测试

```sh
.score-venv/bin/pytest -q tests_py/test_score_to_melody.py
```
