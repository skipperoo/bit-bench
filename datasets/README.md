# Standardized datasets

This folder is mounted read-only into the backend at `/data/datasets`
(`DATASET_DIR`). Every sub-folder is one dataset and every `.bin` file in it
is one **full recording** (a "series"):

```
datasets/
├── wildppg/
│   ├── dataset.yaml          # optional: description + source shown in the UI
│   ├── wrist_ppg_g.bin
│   └── sternum_ecg.bin
├── finance/
│   ├── NVDA.bin
│   └── SPCX.bin
└── synthetic/
    └── random_walk.bin
```

Files use the BitBench `.bin` format (`uint64 N`, `uint64 decimals`,
`N × int64`, little endian; the 8-byte header without `decimals` also works).
Names may contain letters, digits, `.`, `_` and `-`.

Do **not** pre-cut chunks: BitBench cuts each benchmark's inputs at run time
(chunk size in samples or the whole series, max chunks per series, std / gap /
gap_shifted transform) and lets you choose how the results are aggregated.

Create the files with the scripts in `scripts/datasets/`:

```bash
# sample data to try the platform
python3 scripts/datasets/make_synthetic.py

# your own data (CSV columns, NumPy arrays or text files)
python3 scripts/datasets/make_dataset.py csv prices.csv --dataset finance --columns NVDA,SPCX --decimals 2

# the thesis datasets (WildPPG .mat, PAMAP2 .dat files)
python3 scripts/datasets/export_thesis_datasets.py wildppg /path/to/WildPPG.mat
python3 scripts/datasets/export_thesis_datasets.py pamap2 /path/to/PAMAP2_Dataset/Protocol
```

New files show up without restarting the stack. Full guide:
[`docs/datasets.md`](../docs/datasets.md).
