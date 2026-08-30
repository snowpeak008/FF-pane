# 知识库使用指南

本文档用于验证 Markdown 解析路径：标题树、代码块与列表都应原样保留，
由 T6.2 分块器自行按标题层级切分。

## 安装

支持 Windows 与 Linux 两个平台。

### Windows

1. 下载安装包
2. 双击运行
3. 首次启动会自动初始化 `~/.aiworkbench/` 目录

```bash
pnpm install
pnpm dev
```

## 常见问题

- **索引损坏怎么办？** 删除 `index.sqlite`，应用会自动重建。
- **支持哪些格式？** Markdown、txt、源代码、PDF、docx、html。
