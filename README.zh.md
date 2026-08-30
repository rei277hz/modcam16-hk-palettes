# modCAM16-HK 调色板

Language / 语言: [English](README.md) | [中文](README.zh.md)

`modcam16-palette` 生成径向色彩调色板，使其中的彩色样本保持共同的感知亮度。
它面向在 ACES 或广色域 RGB 工作流中工作的色彩科学家、HDR/显示工程师和艺术家。
原始的 `make_modcam16-hk_palettes4.0.py` 脚本仍作为该软件包的兼容启动器保留。

## 模型功能

亥姆霍兹-科尔劳施（H-K）效应是指在测得的亮度相同的情况下，色彩度增加通常伴随感知亮度增加。
调色板使用修订版 CAM16 属性 `J`（明度）、`C`（色度）、`Q`（亮度）以及 `A_W`（参考白的无彩响应），然后应用 Hellwig 2023 H-K 扩展：

```text
J_HK = sqrt(J^2 + 66 C)
Q_HK = (2 / c) (J_HK / 100) A_W
```

`c` 是取决于周围环境的 CAM16 系数。
`66` 是默认的 `appearance.hk_chroma_coefficient`，可在 TOML 中更改；上述方程描述的是内置行为。
每个径向环都是恒定 `J_HK` 的样本。
色度按所选 RGB 色域对每个色相加以限制，因此每个色相都可以提供一个最终边界帽。

在底层的修订版 CAM16 方程中，`A` 是刺激物的无彩响应，而 `z = 1.48 + sqrt(Y_b / Y_w)` 根据背景和白色亮度推导得到。
观看条件参数可在 TOML 的 `[appearance]` 部分配置。

## 应该使用哪种调色板？

所有普通文件和补偿文件都是场景线性 ACEScg OpenEXR 文件（ACEScg 使用 AP1 原色）。
这里的“直接”表示不进行额外的调色板补偿。
这并不意味着打开该文件的应用程序不需要显示监看或视图变换。

| 变体 | 预期用途 |
| --- | --- |
| **直接 ACEScg/AP1** | 面向 ACES 1.3/2.0 绘图、DaVinci 调色和基础色纹理工作的默认通用调色板；包含默认的 sRGB 边界标记。 |
| **直接 sRGB-D65** | 当源颜色应保持在 sRGB 色域内时，用于通用绘图、调色或纹理工作。 |
| **直接 P3-D65** | 用于支持 P3 的工作流中的通用绘图或纹理工作；不应用视图变换补偿。 |
| **针对 ACES 2.0 HDR 补偿的 P3-D65** | HDR 内容制作；与匹配的 ACES 2.0 Rec.2020 / Rec.2100-PQ 视图变换配合使用。逆补偿旨在使调色板经过该视图变换后仍保持 H-K 均匀亮度，其 18 个 ColorChecker 点也在视图变换后进行匹配。 |
| **针对 ACES 2.0 SDR 补偿的 sRGB-D65** | 用于 Rec.709 / BT.1886 ACES 2.0 路径，但尚未在实践中测试。它属于实验性功能，请谨慎使用。 |

补偿变体是 sRGB-D65 或 P3-D65 中的源调色板，在逆 ACES 2.0 视图变换之后转换为 ACEScg。
显示编码不会烘焙到 EXR 中。
随附的 ACES 2.0 CG 配置目前定义了 P3/Rec.2020 HDR 和 sRGB/Rec.709 SDR 配置文件；它没有定义 AP1 补偿配置文件。

## 生成的功能

- 具有对数压缩色度等级的等 `J_HK` 径向环。
- 每个色相一个带可配置安全内缩的色域边界帽。
- 可选的 sRGB 和 P3 边界矩形，叠加在调色板上。
- 可选的前 18 个彩色 ColorChecker 色块点。
- 可选的 ACES 2.0 逆视图变体，包括特定配置文件的中性点求解和曝光鲁棒的 ACES-`J` 锚点拟合。

普通 ColorChecker 点在源修订版 modCAM16-HK 饱和度/色相空间中通过曝光扫描分配；普通匹配不使用 ACES。
补偿点在固定逆视图颜色后分配：每个候选点使用同一曝光网格评估，经过所选正向视图变换，然后在归一化的笛卡尔 ACES `JMh` 中与固定 D65 目标比较。
每个色块独立匹配，因此候选位置可以重复使用。
内置的 ColorChecker 标记网格对两种调色板都包含从 `-5` 到 `+5` 档、步长为 `0.1` 档的所有值（101 个样本）。

可以使用 `colorchecker.compensated_marker_exposure_*` TOML 键（或中性的 `colorchecker.exposure_*` 别名）以及对应的 CLI 标志调整网格。
辅助脚本 [`scripts/analyze_compensated_cc18_grid.py`](scripts/analyze_compensated_cc18_grid.py) 将配置的网格与更细的参考网格进行比较。

对于 P3 HDR 配置文件，源 P3 边界还会与 Rec.2020-D65 锥体求交，因为 P3 有一小条红色原色区域位于 Rec.2020 之外。
所选 ACES 视图具有有限的显示峰值：SDR 100 nit 路径在线性 RGB `1` 处设上限，而 HDR 1000 nit 路径在显示参考空间中设为 `10`。
不可达目标会在求逆之前投影到该有界体积中；投影和往返诊断信息会报告在元数据中。

## 安装

需要 Python 3.11 或更高版本。
请从仓库安装软件包及其运行时依赖：

```sh
python3 -m pip install -e .
```

同时安装测试依赖：

```sh
python3 -m pip install -e '.[test]'
```

ACES 补偿使用 `opencolorio==2.5.2` 和随附的 `cg-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio`。
普通调色板不需要加载 OCIO 处理器，但生成调色板仍需要 OpenEXR 和 NumPy 运行时依赖。

## 快速开始

在当前目录生成默认选择（3 个普通调色板和符合条件的补偿变体）：

```sh
python3 make_modcam16-hk_palettes4.0.py
```

同一个入口也可以作为模块以及已安装的控制台脚本使用：

```sh
python3 -m modcam16_palette --help
modcam16-palette --help
```

要在单独的目录中快速渲染仅普通调色板：

```sh
python3 make_modcam16-hk_palettes4.0.py \
  --no-compensation \
  --gamut ap1 \
  --output-dir ./out \
  --image-size 512 \
  --hue-count 12 \
  --chroma-level-count 3
```

一个实用的 P3 HDR 请求如下：

```sh
python3 make_modcam16-hk_palettes4.0.py \
  --gamut p3 \
  --compensation-profile p3_rec2020_pq \
  --output-dir ./out
```

生成过程会打印求解得到的模型、色域边界、ColorChecker 以及（启用时）ACES 补偿诊断信息。
完整分辨率的连续边界运行可能比上面的小示例耗时显著更长。

## 发布构建

签入的 `config.release.toml` 与 `config.example.toml` 按字节完全相同，并作为可复现的五调色板发布输入。
运行发布入口会生成全部 3 个直接调色板和配置的 2 个 ACES 2.0 变体：

```sh
python3 make_release.py
```

同一个函数也可通过 `modcam16_palette.generate_release()` 和已安装的 `modcam16-palette-release` 命令使用。
发布文件使用短名称 `sRGB_Direct_Palette.exr`、`P3_Direct_Palette.exr`、
`AP1_Direct_Palette.exr`、`sRGB_ACES2_SDR.exr` 和 `P3_ACES2_HDR.exr`；每个名称最多包含 3 个下划线分隔段。
使用 `--output-dir` 可将文件放到其他目录。

## 配置

配置首先从 TOML 读取；显式的命令行值会覆盖它。
完整配置模式（包括求解器容差和所有补偿控制项）见 [`config.example.toml`](config.example.toml)。
一个最小的仅普通调色板配置如下：

```toml
[output]
directory = "./out"
gamuts = ["ap1"]

[compensation]
enabled = false
```

示例文件是规范的发布配置，其中的值就是内置默认值。
TOML 文件中省略的值会保留这些默认值。
内置调色板默认值如下：

| 设置 | 默认值 |
| --- | ---: |
| 参考白 | 200 nit |
| 色相扇区 | 48 |
| 完整色度等级 | 12 |
| 普通压缩 `k`（sRGB / P3 / AP1） | 12 / 13 / 15 |
| 边界帽高度 | 一个完整色块的 0.5 |
| sRGB 边界矩形 | 启用 |
| P3 边界矩形 | 禁用 |
| ColorChecker 点 | 启用，使用 official-after-2014 数据，半径 6 像素 |
| ColorChecker 匹配网格 | `-5..+5` 档，步长 `0.1` 档（101 个样本） |
| 补偿拟合 | 自动，`-3..0` 档，步长 `0.5` 档 |
| 补偿压缩 `k`（sRGB / P3） | 2.0 / 20.0 |

数值型 `target_intermediate_center` 会为手动/旧版补偿保留。
在默认的 `fit_mode = "auto"` 中，每个配置文件根据 7 个曝光样本 `-3, -2.5, ..., 0` 档拟合一个锚点。
将 `fit_mode = "manual"`（或使用 `--compensation-fit-mode manual`）设为手动模式即可使用显式锚点。

规范的补偿配置文件 ID 是 `srgb_rec709_bt1886`（ACES 2.0 SDR 100 nit Rec.709，带 BT.1886 诊断）和 `p3_rec2020_pq`（ACES 2.0 HDR 1000 nit Rec.2020，带 Rec.2100-PQ 诊断）。

## CLI 要点

运行 `--help` 查看完整选项列表。
最常用的选项如下：

| 选项 | 作用 |
| --- | --- |
| `--config PATH` | 加载 TOML 文件。 |
| `--output-dir PATH` | 选择输出目录。 |
| `--gamut all` 或重复使用 `--gamut srgb`、`--gamut p3`、`--gamut ap1` | 选择源色域。 |
| `--image-size N` | 设置方形栅格尺寸（必须为偶数）。 |
| `--hue-count N`、`--chroma-level-count N` | 设置调色板采样密度。 |
| `--srgb-k K`、`--p3-k K`、`--ap1-k K` | 设置普通对数色度压缩。 |
| `--srgb-boundary-markers`、`--p3-boundary-markers` | 启用或禁用参考色域矩形。 |
| `--colorchecker-markers`、`--colorchecker-dataset ...` | 控制 18 个色块点。 |
| `--no-compensation` / `--compensation` | 禁用或启用 ACES 2.0 变体。 |
| `--compensation-profile PROFILE` | 选择符合条件的配置文件；重复该选项可选择多个配置文件。 |
| `--ocio-config PATH` | 使用其他 OCIO 配置。 |
| `--compensation-fit-mode auto` 或 `manual` | 选择拟合或显式补偿锚点。 |
| `--compensation-exposure-*` | 设置 ACES-`J` 拟合的曝光范围和步长。 |
| `--colorchecker-compensated-exposure-*`（或 `--colorchecker-exposure-*`） | 设置普通和补偿调色板的 ColorChecker 曝光匹配网格。 |

CLI 显示的别名（如 `srgb`、`p3`、`ap1`、`rec709_bt1886` 和 `rec2020_pq`）在相应位置均可接受。
`--gamut all` 不能与额外的 `--gamut` 值组合使用。

## 文件和数量

对于每个选定的源色域，都会写入一个普通文件。
补偿按配置文件分别处理，且只有在选择了其源色域时才会运行：

选择全部 3 个色域时，默认运行会写入 3 个普通调色板以及 sRGB 和 P3 补偿变体，共 5 个文件。

| 选择 | 普通文件 | 默认补偿下的附加文件 |
| --- | ---: | ---: |
| `all`（默认） | 3 | 2，共 5 个 |
| `srgb` | 1 | 1 个 sRGB/Rec.709 SDR 配置文件 |
| `p3` | 1 | 1 个 P3/Rec.2020 HDR 配置文件 |
| `ap1` | 1 | 无（未定义 AP1 配置文件） |

`--no-compensation` 会使附加文件数量变为零。
选择源色域未被选中的配置文件也不会产生额外文件。

普通文件名遵循以下模式：

```text
modCAM16HK_<white>nit_<gamut>GamutCone_C3_<levels>Step_LogK<k>_Cap<height>_<markers>_<colorchecker>_ACEScg_Radial_32f.exr
```

补偿文件名会加入 ACES 配置文件、拟合锚点、源中性点和拟合曝光网格。
手动/旧版名称则会加入显式的 `TargetY` 和 `Scale` 值。
命名方式有意保持描述性，因此更改采样、标记或补偿设置不会悄然覆盖另一张调色板。

## 输出格式和元数据

每个输出都是带有一个三通道 `RGB` 图像的扫描线 OpenEXR：

- 场景线性 ACEScg/AP1 值；
- IEEE 32 位浮点通道；
- ZIP 压缩；
- 标头中的 `ocioColorSpace = "ACEScg"`。

普通调色板不包含烘焙的传递函数、裁剪、色调映射、色域映射或显示变换。
即使使用自定义的 CAM16 中性点 Y 求解调色板，其中心也始终精确为 `(1, 1, 1)`。
背景和参考标记矩形保留配置的背景值。
大于 1 的值是有效的场景线性值，不会被裁剪。

补偿文件会将逆 ACES 2.0 视图变换烘焙到前景调色板颜色中，然后将前景中心归一化为 `(1, 1, 1)`；
显示编码仍保持独立。
其标头和注释会记录配置文件/视图、OCIO 配置和缓存 ID、求解得到的源 Y、拟合/手动锚点、前景缩放、目标体积投影计数、有限峰值、补偿 ColorChecker 匹配数据以及往返容差/误差。
生成过程会在标准输出中报告相同的诊断信息。

## 实现审计和范围

我们根据随附论文和维护中的 `colour-science` Hellwig 实现检查了该实现：

- Hellwig 等人 2023 年的方程 8（`J_HK`）和方程 9（`Q_HK`）与 `AppearanceModel` 使用的方程一致。
- XCR 表中展示的修订版 CAM16 项与实现一致：修正后的偏心率 `e_t`、`M = 43 N_c e_t sqrt(a^2 + b^2)`、`C = 35 M / A_W`、`s = 100 M / Q`、`J = 100 (A/A_W)^(c z)` 以及 `Q = (2/c) (J/100) A_W`。
- 调色板栅格化、径向环和边界帽几何、色域边界求解、ColorChecker 放置以及 ACES 逆视图补偿都是本项目的扩展。该仓库不声称实现完整的 XCR 工具包或所有 XCR 分析和可视化功能。
- 2022 年的加法模型 `J_HK = J + f(h) C^0.587` 属于相关工作，并不是这些调色板使用的模型。
- XCR 表 1 打印了 `0.1457` 的正弦系数，而且似乎重复了常数项。我们将这些条目视为排版/源材料不一致：保留的 `0.1475` 系数和单个 `+1` 与维护中的 `colour-science` Hellwig 代码一致，并由此处的回归测试锁定。发布默认值和文档化的 ColorChecker 曝光匹配 API 也由回归测试覆盖。

## 参考资料

- Hellwig、Stolitzka 和 Fairchild，“The brightness of chromatic stimuli”，
  *Color Research and Application*（2024），
  [doi:10.1002/col.22910](https://doi.org/10.1002/col.22910)。
- Hellwig、Stolitzka 和 Fairchild，“Improvements to CIECAM16 and Future
  Directions”，CIE 2023 proceedings，
  [doi:10.25039/x50.2023.pp011](https://doi.org/10.25039/x50.2023.pp011)。
- Stolitzka、Agahian 和 Poynton，“Modeling the HDR Display with XCR”，
  *Information Display*（2025），
  [doi:10.1002/msid.1596](https://doi.org/10.1002/msid.1596)。
- Hellwig、Stolitzka 和 Fairchild，“Extending CIECAM02 and CAM16 for the
  Helmholtz-Kohlrausch effect”，*Color Research and Application*（2022），
  [doi:10.1002/col.22793](https://doi.org/10.1002/col.22793)。

这些论文是模型参考资料；生成的 EXR 是项目产物，应结合生成它们时使用的视图变换和配置进行解释。
