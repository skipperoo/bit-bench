// BitBench example compressor: delta + zigzag LEB128 (Rust).
// See docs/user-compressors.md for the package and output contract.
use std::fs;
use std::process;
use std::time::Instant;

const NAME: &str = "example_delta_rust";
const CSV_HEADER: &str = "compressor,dataset,num_values,original_size,memory_usage,\
uncompressed_bits,compressed_bits,compression_ratio,\
compression_throughput_mbs,decompression_throughput_mbs,\
random_access_ns,random_access_mbs";

struct Options {
    mode: String,
    verify: bool,
}

fn zigzag_encode(value: i64) -> u64 {
    ((value as u64) << 1) ^ ((value >> 63) as u64)
}

fn zigzag_decode(value: u64) -> i64 {
    ((value >> 1) as i64) ^ -((value & 1) as i64)
}

fn write_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn read_varint(input: &[u8], index: &mut usize) -> u64 {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = input[*index];
        *index += 1;
        result |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return result;
        }
        shift += 7;
    }
}

// Minimal JSON scan for the two example options. The JSON file takes
// precedence over the CLI flags.
fn apply_json_options(path: &str, opts: &mut Options) {
    let json = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return,
    };

    if let Some(pos) = json.find("\"mode\"") {
        if let Some(colon) = json[pos..].find(':') {
            let rest = &json[pos + colon + 1..];
            if let Some(open) = rest.find('"') {
                if let Some(close) = rest[open + 1..].find('"') {
                    opts.mode = rest[open + 1..open + 1 + close].to_string();
                }
            }
        }
    }

    if let Some(pos) = json.find("\"verify\"") {
        if let Some(colon) = json[pos..].find(':') {
            opts.verify = json[pos + colon + 1..].contains("true");
        }
    }
}

fn read_bin(path: &str) -> Result<Vec<i64>, String> {
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    if raw.len() < 8 {
        return Err("input file too small".into());
    }

    let count = u64::from_le_bytes(raw[0..8].try_into().unwrap());
    let offset = if raw.len() as u64 == 16 + count * 8 {
        16usize
    } else if raw.len() as u64 == 8 + count * 8 {
        8usize
    } else {
        return Err("input size does not match either .bin header format".into());
    };

    let mut values = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let start = offset + i * 8;
        values.push(i64::from_le_bytes(raw[start..start + 8].try_into().unwrap()));
    }
    Ok(values)
}

fn main() {
    let mut opts = Options {
        mode: "delta".to_string(),
        verify: true,
    };
    let mut out_path: Option<String> = None;
    let mut in_path: Option<String> = None;
    let mut options_path: Option<String> = None;

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-o" && i + 1 < args.len() {
            out_path = Some(args[i + 1].clone());
            i += 2;
        } else if arg == "--options" && i + 1 < args.len() {
            options_path = Some(args[i + 1].clone());
            i += 2;
        } else if let Some(value) = arg.strip_prefix("--mode=") {
            opts.mode = value.to_string();
            i += 1;
        } else if let Some(value) = arg.strip_prefix("--verify=") {
            opts.verify = value == "true";
            i += 1;
        } else if !arg.starts_with('-') {
            in_path = Some(arg.clone());
            i += 1;
        } else {
            i += 1;
        }
    }

    if let Some(path) = &options_path {
        apply_json_options(path, &mut opts);
    }

    let (out_path, in_path) = match (out_path, in_path) {
        (Some(out), Some(input)) => (out, input),
        _ => {
            eprintln!("usage: codec -o <out.csv> [--options <opts.json>] <input.bin>");
            process::exit(1);
        }
    };

    let values = match read_bin(&in_path) {
        Ok(values) => values,
        Err(err) => {
            eprintln!("cannot read input {}: {}", in_path, err);
            process::exit(1);
        }
    };

    let mut compressed: Vec<u8> = Vec::with_capacity(values.len() * 5 + 16);
    let started = Instant::now();
    let mut previous: i64 = 0;
    for &value in &values {
        let delta = if opts.mode == "raw" { value } else { value - previous };
        previous = value;
        write_varint(&mut compressed, zigzag_encode(delta));
    }
    let compressed_at = Instant::now();

    if opts.verify {
        let mut index = 0usize;
        previous = 0;
        for (i, &want) in values.iter().enumerate() {
            let delta = zigzag_decode(read_varint(&compressed, &mut index));
            let value = if opts.mode == "raw" { delta } else { previous + delta };
            if value != want {
                eprintln!("round-trip verification failed at {}", i);
                process::exit(1);
            }
            previous = value;
        }
    }
    let verified_at = Instant::now();

    let count = values.len();
    let original_size = (count * 8) as u64;
    let uncompressed_bits = (count * 64) as u64;
    let compressed_bits = (compressed.len() * 8) as u64;
    let ratio = if uncompressed_bits > 0 {
        compressed_bits as f64 / uncompressed_bits as f64
    } else {
        0.0
    };
    let compress_secs = compressed_at.duration_since(started).as_secs_f64();
    let verify_secs = verified_at.duration_since(compressed_at).as_secs_f64();
    let compress_mbs = if compress_secs > 0.0 {
        (original_size as f64 / 1048576.0) / compress_secs
    } else {
        0.0
    };
    let decompress_mbs = if verify_secs > 0.0 {
        (original_size as f64 / 1048576.0) / verify_secs
    } else {
        0.0
    };

    let line = format!(
        "{},example,{},{},,{},{},{:.6},{:.3},{:.3},,\n",
        NAME, count, original_size, uncompressed_bits, compressed_bits, ratio, compress_mbs, decompress_mbs
    );

    if let Err(err) = fs::write(&out_path, format!("{}\n{}", CSV_HEADER, line)) {
        eprintln!("cannot write output {}: {}", out_path, err);
        process::exit(1);
    }
}
