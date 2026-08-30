<img src="assets/demo.webp">

*演示：在配置了 ACES 2.0 OCIO 配置的 Photoshop 文档中加载 `P3-GamutCone_ACES2-Rec2020-PQ-Compensated_ACEScg-fp32.exr`（画面左上角），并在下方加载 24 色 ColorChecker 色卡。针对其中三个色块，依次用滴管工具从调色盘吸取颜色、用笔刷在对应色块上画一笔、再调整曝光直至绘制颜色与参考色匹配。文档的 Display 设为 `Rec.2100-PQ - Display`，View 选择了符合制作目标和笔者笔记本屏幕的选项（HDR 1000 nit、P3-D65、Match OS Display Profile），与该调色盘的补偿目标（ACES 2.0 Rec.2020 / Rec.2100-PQ，1000 nit）一致。*

# modCAM16-HK 调色盘

Language / 语言: [English](README.md) | [中文](README.zh.md)

用于绘画、贴图制作和 ACES 流程的等感知亮度调色盘。

这些调色盘补偿了 **Helmholtz–Kohlrausch（H–K）效应**：在测量亮度相同时，高彩度颜色通常会显得更亮。它们适用于：

- 绘制感知亮度一致的基础色（固有色）；
- 在绘画或基础色贴图制作时，将色彩选择和曝光调整分离；
- 适用于 ACES 2.0 显示变换的颜色选择；
- 使用 ColorChecker 色块作为熟悉的选色参考。

## Release 调色盘

从 [Releases](../../releases) 下载以下五个 `.exr` 文件。

所有 Release 文件采用相同的 EXR 编码：场景线性 ACEScg/AP1，三通道 RGB，IEEE float32。文件名中的 `sRGB` 或 `P3` 描述调色盘的色域边界，EXR 本身仍为 ACEScg/AP1。

| 文件 | 调色盘覆盖色域 | 需要配合的 ACES 显示变换 | 使用场景 |
| --- | --- | --- | --- |
| `sRGB-GamutCone_ACEScg-fp32.exr` | sRGB-D65 | 无 | 限制在 sRGB 色域内的普通绘画和贴图制作 |
| `P3-GamutCone_ACEScg-fp32.exr` | P3-D65 | 无 | 普通广色域绘画和贴图制作 |
| `AP1-GamutCone_ACEScg-fp32.exr` | ACEScg/AP1 | 无 | ACES 或其他场景线性广色域流程 |
| `sRGB-GamutCone_ACES2-Rec709-BT1886-Compensated_ACEScg-fp32.exr` | sRGB-D65 | ACES 2.0 Rec.709 / BT.1886，100 nit | ACES 2.0 SDR 流程 |
| `P3-GamutCone_ACES2-Rec2020-PQ-Compensated_ACEScg-fp32.exr` | P3-D65，并受 Rec.2020 边界约束 | ACES 2.0 Rec.2020 / Rec.2100-PQ，1000 nit | ACES 2.0 HDR 内容制作 |

“无”表示该调色盘仅补偿 H–K 效应，应用程序仍需执行正常的色彩管理或显示转换。

## 使用方法

### 1. 将 EXR 识别为场景线性 ACEScg

所有 Release 文件均使用 AP1 原色和 float32 线性 RGB。将文件名中的色域视为调色盘的色域边界，并将 EXR 编码视为 ACEScg/AP1。

### 2. 选择调色盘

按以下决策树选择：

1. **你的工作流是否包含 ACES 显示变换？**
   - **否** → 使用仅补偿 H–K 的（“直接版”）调色盘，进入第 2 步。
   - **是** → 使用针对显示变换补偿的调色盘，进入第 3 步。

2. **（无 ACES 显示变换）选择哪个直接版？**
   - 默认：使用**直接版 P3** 调色盘。
   - 明确需要限制在 sRGB 色域：使用**直接版 sRGB** 调色盘。
   - 需要 ACEScg/AP1 色域并配合非 ACES 2.0 的显示变换（例如 OpenDRT v1.0.0）：尝试使用**直接版 ACEScg/AP1** 调色盘。

3. **（有 ACES 2.0 显示变换）制作目标是 SDR 还是 HDR？**
   - **SDR 视频 / 图片** → 使用针对 **ACES 2.0 Rec.709 / BT.1886** 补偿的调色盘。
   - **HDR 视频 / 图片** → 使用针对 **ACES 2.0 Rec.2020 / Rec.2100-PQ，1000 nit** 补偿的调色盘。

将补偿版调色盘与其严格对应的 ACES 2.0 显示变换和显示峰值亮度配合使用。

如上方演示所示，补偿版调色盘只有在配合与其对应的 ACES 2.0 显示变换和 View 时，才能得到正确的颜色匹配结果。演示中，H–K 补偿调色盘、色彩与曝光分离的采样流程以及 ColorChecker 参考色之所以都能按预期工作，正是因为文档的 Display 和 View 与该调色盘的补偿目标一致。

### 3. 从径向布局中选色

- 角度表示色相。
- 到中心的距离表示彩度。
- 最外侧窄色块表示每个色相可达到的色域边界。
- ColorChecker 圆点标记前 18 个彩色色块，可作为辅助选色参考。

在色彩与曝光分离的流程中，先从调色盘选择基础色，再用场景线性曝光操作调整明暗，同时保持所选基础色不变。

## 作品示例

<img src="assets/exit-sign_p3d65-pq_hdr.jpg">

这幅 HDR 画作是笔者使用开发早期的调色盘绘制而成，其效果相当于现在的**直接版 ACEScg/AP1**，创作时配合了非 ACES 2.0 的显示变换（OpenDRT v1.0.0 Default），后期在 DaVinci Resolve 中完成调色。直接版 P3 和 sRGB 覆盖了最常见的工作流，而直接版 ACEScg/AP1 在其他显示变换下进行广色域绘画时同样是一个值得选用的方案。

## 科学依据

在光度亮度相同的条件下，彩色刺激会随着彩度增加而显得更亮，这一现象称为 Helmholtz–Kohlrausch 效应。Hellwig、Stolitzka 和 Fairchild 将该效应纳入了修订后的 CAM16 模型 [1,2]。本项目使用以下修订 H–K 明度相关量：

`J_HK = sqrt(J² + 66 C)`

调色盘在改变色相和彩度的同时，使模型预测的感知亮度近似保持不变；每个色相的最大彩度则根据目标 RGB 色域独立求解。

普通 RGB 绘画工具提供的是基于测量亮度的控制，而非经过 H–K 补偿的感知亮度恒定量。ACES 2.0 提供从场景到显示的渲染变换，并将选色交给创作者 [5]。因此，直接版在构建调色盘时补偿 H–K 效应；ACES 版本还会针对指定的 ACES 2.0 显示变换进行额外补偿。

实现所使用的修订 CAM16 与 H–K 等式对应文献 [1,2]。文献 [4] 中较早的加法 H–K 扩展属于相关研究，与本项目采用的模型有所区别。ACES 补偿版使用项目内附的 ACES 2.0 OCIO 配置求解并进行往返检查，所用配置、显示变换和误差诊断均写入 EXR 元数据。

最终结果仍是颜色外观模型的预测，并取决于假定的观察条件、显示变换和显示设备校准。

## 本地生成

需要 Python 3.11 或更高版本。

```sh
python3 -m pip install -e .
python3 make_release.py
```

该命令使用 `config.release.toml` 生成相同的五个调色盘版本。

## 许可

除非文件或目录另有说明，本仓库中的原创源代码和测试代码采用 Apache-2.0 许可，详见
[`LICENSE`](LICENSE)。GitHub Releases 页面上发布的五个调色盘 EXR 文件依据 CC0-1.0 放弃到公有领域，详见
[`LICENSE-CC0-1.0.txt`](LICENSE-CC0-1.0.txt)。发布资产中应附带该声明的副本，便于独立分发。
随附的 ACES OCIO 配置属于第三方材料，遵循其上游 BSD-3-Clause 许可，详见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。CC0 放弃仅适用于本项目对生成调色盘产物拥有的权利；不授予对第三方
ColorChecker 名称/数据、ACES 标志或变换以及其他引用材料的权利。演示作品和截图是独立媒体，不包含在调色盘的 CC0 放弃范围内。

## 参考文献

1. Hellwig, L., Stolitzka, D., and Fairchild, M. D. “The brightness of chromatic stimuli.” *Color Research & Application* (2024). [doi:10.1002/col.22910](https://doi.org/10.1002/col.22910)
2. Hellwig, L., Stolitzka, D., and Fairchild, M. D. “Improvements to CIECAM16 and Future Directions.” *CIE 2023 Proceedings* (2023). [doi:10.25039/x50.2023.pp011](https://doi.org/10.25039/x50.2023.pp011)
3. Stolitzka, D., Agahian, F., and Poynton, C. “Modeling the HDR Display with XCR.” *Information Display* (2025). [doi:10.1002/msid.1596](https://doi.org/10.1002/msid.1596)
4. Hellwig, L., Stolitzka, D., and Fairchild, M. D. “Extending CIECAM02 and CAM16 for the Helmholtz–Kohlrausch effect.” *Color Research & Application* (2022). [doi:10.1002/col.22793](https://doi.org/10.1002/col.22793)
5. Academy Color Encoding System. “Output Transforms.” [ACES Documentation](https://docs.acescentral.com/system-components/output-transforms/)
