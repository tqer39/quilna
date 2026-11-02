#!/bin/sh
set -eu

task_script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_package_directory=$(CDPATH= cd -- "$task_script_directory/.." && pwd)
task_scratch_path=${TSUMIKI_SWIFT_SCRATCH_PATH:-/private/tmp/quilna-swift-build}
task_cache_path=${TSUMIKI_SWIFT_CACHE_PATH:-/private/tmp/quilna-swift-cache}
task_bundle_path="$task_package_directory/.build/native/Quilna.app"

swift build --package-path "$task_package_directory" --scratch-path "$task_scratch_path" --cache-path "$task_cache_path" -c release
task_binary_directory=$(swift build --package-path "$task_package_directory" --scratch-path "$task_scratch_path" --cache-path "$task_cache_path" -c release --show-bin-path)
mkdir -p "$task_bundle_path/Contents/MacOS"
cp "$task_binary_directory/Quilna" "$task_bundle_path/Contents/MacOS/Quilna"
cat > "$task_bundle_path/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Quilna</string>
<key>CFBundleIdentifier</key><string>work.tqer39.tsumikitext.prototype.mac</string>
<key>CFBundleName</key><string>Quilna</string>
<key>CFBundleDisplayName</key><string>Quilna</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
printf '%s\n' "$task_bundle_path"
