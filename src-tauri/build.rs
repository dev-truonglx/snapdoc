fn main() {
    // Key Aptabase lấy từ biến môi trường APTABASE_KEY (CI) hoặc từ file
    // `.env.local` ở gốc repo (máy dev, đã nằm trong .gitignore qua `*.local`).
    // Không có key → telemetry tắt hẳn, build vẫn chạy bình thường.
    println!("cargo:rerun-if-env-changed=APTABASE_KEY");
    println!("cargo:rerun-if-changed=../.env.local");
    if std::env::var("APTABASE_KEY").map_or(true, |v| v.is_empty()) {
        if let Ok(content) = std::fs::read_to_string("../.env.local") {
            for line in content.lines() {
                if let Some(v) = line.trim().strip_prefix("APTABASE_KEY=") {
                    let v = v.trim().trim_matches('"');
                    if !v.is_empty() {
                        println!("cargo:rustc-env=APTABASE_KEY={v}");
                    }
                }
            }
        }
    }
    tauri_build::build();
}
