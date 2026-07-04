import glob
import os
import sys

import pandas as pd

datasets = {}


def locate_datasets(files: list[str]):
    global datasets
    for file in files:
        parts = os.path.basename(file).split("_")
        if len(parts) == 4:
            name, location, signal, _ = parts
        else:
            name = parts[0]
            location = parts[1]
            signal = "_".join(parts[2:-1])

        if datasets.get(name) is None:
            datasets[name] = {"locations": {}}
        if datasets[name]["locations"].get(location) is None:
            datasets[name]["locations"][location] = set()
        datasets[name]["locations"][location].add(signal)


def process_dataset(files: list[str], dataset: str, location: str, signal: str):
    target_files = [
        f
        for f in files
        if os.path.basename(f).startswith(f"{dataset}_{location}_{signal}")
    ]
    dfs = [pd.read_csv(f, on_bad_lines="skip") for f in target_files]
    combined_df = pd.concat(dfs, ignore_index=True)
    memory_csv = os.path.join(os.path.dirname(target_files[0]), "memory.csv")
    if os.path.isfile(memory_csv):
        memory_df = pd.read_csv(memory_csv, on_bad_lines="skip")
        memory_df.columns = memory_df.columns.str.strip()
        required_cols = {"compressor", "dataset", "memory_usage"}
        if required_cols.issubset(set(memory_df.columns)):
            # Include optional breakdown columns if present
            extra_cols = [c for c in ["input_buffer", "compressor_internal"] if c in memory_df.columns]
            cols_to_keep = ["compressor", "dataset", "memory_usage"] + extra_cols
            
            memory_df = memory_df[cols_to_keep].copy()
            memory_df["compressor"] = memory_df["compressor"].astype(str).str.strip().str.lower()
            memory_df["dataset"] = memory_df["dataset"].astype(str).str.strip()
            
            for col in ["memory_usage"] + extra_cols:
                memory_df[col] = pd.to_numeric(memory_df[col], errors="coerce")
            
            memory_df = memory_df.dropna(subset=["memory_usage"])
            combined_df["signal_dataset"] = combined_df["dataset"].astype(str).str.replace(
                r"_\d+$", "", regex=True
            )
            combined_df["compressor_lower"] = combined_df["compressor"].astype(str).str.lower()
            combined_df = combined_df.merge(
                memory_df,
                left_on=["compressor_lower", "signal_dataset"],
                right_on=["compressor", "dataset"],
                how="left",
                suffixes=("", "_override"),
            )
            
            if "memory_usage_override" in combined_df.columns:
                combined_df["memory_usage"] = combined_df[
                    "memory_usage_override"
                ].combine_first(combined_df.get("memory_usage"))
                
                for col in extra_cols:
                    if f"{col}_override" in combined_df.columns:
                        combined_df[col] = combined_df[f"{col}_override"]
                
                # Calculate internal memory ratio
                if "compressor_internal" in combined_df.columns and "input_buffer" in combined_df.columns:
                    combined_df["internal_memory_ratio"] = combined_df["compressor_internal"] / combined_df["input_buffer"].replace(0, pd.NA)

            drop_cols = ["signal_dataset", "dataset_override", "memory_usage_override", "compressor_lower", "compressor_override"]
            for col in extra_cols:
                drop_cols.append(f"{col}_override")
                
            combined_df = combined_df.drop(
                columns=drop_cols,
                errors="ignore",
            )
    combined_df["dataset"] = combined_df["dataset"].str.replace(
        r"_\d+$", "", regex=True
    )
    mean_df = combined_df.groupby(["compressor", "dataset"]).mean(numeric_only=True).reset_index()
    # mean_df.to_csv(f"{dataset}_{location}_{signal}.txt", index=False)
    return mean_df


def main():
    global datasets
    if len(sys.argv) != 2:
        print(f"Usage: python {sys.argv[0]} /path/to/results")
    results_path = (
        os.path.dirname(sys.argv[1]) if os.path.isfile(sys.argv[1]) else sys.argv[1]
    )
    files = glob.glob(f"{results_path}/*.txt")
    locate_datasets(files)
    dfs = []
    for ds in datasets.keys():
        for location in datasets[ds]["locations"].keys():
            for signal in datasets[ds]["locations"][location]:
                dfs.append(process_dataset(files, ds, location, signal))
    full_df = pd.concat(dfs, ignore_index=True)
    full_df.to_csv(f"{results_path}/results.csv", index=False)


if __name__ == "__main__":
    main()
