# React Native (iOS) build of the native binding: cpp/ over csrc/ljs.c and the
# bundled lz4 sources, the same C code as the Node-API addon and the WebAssembly build.
require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))
lz4 = "deps/lz4/lib"

Pod::Spec.new do |s|
  s.name         = "KodespireLz4"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/kodespire/lz4-js.git", :tag => "v#{s.version}" }

  # The files scripts/lz4-sources.cjs lists, and their headers. Not lib/lz4file.c.
  s.source_files = [
    "ios/*.{h,mm}",
    "cpp/*.{h,cpp}",
    "csrc/ljs.{h,c}",
    "#{lz4}/{lz4,lz4hc,lz4frame,xxhash}.{h,c}",
    "#{lz4}/lz4frame_static.h",
  ]
  # Only the provider is public, so lz4's headers (xxhash.h, ...) never shadow another pod's.
  s.public_header_files = "ios/*.h"

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "\"$(PODS_TARGET_SRCROOT)/cpp\" \"$(PODS_TARGET_SRCROOT)/csrc\" " \
                             "\"$(PODS_TARGET_SRCROOT)/#{lz4}\"",
    # Same defines as binding.gyp and scripts/build-wasm.mjs.
    "GCC_PREPROCESSOR_DEFINITIONS" => "$(inherited) XXH_NAMESPACE=LZ4_",
    "GCC_OPTIMIZATION_LEVEL" => "3",
    "GCC_SYMBOLS_PRIVATE_EXTERN" => "YES",
    # Xcode's defaults flag a few idioms in lz4's sources.
    "CLANG_WARN_COMMA" => "NO",
    "CLANG_WARN_UNREACHABLE_CODE" => "NO",
  }

  install_modules_dependencies(s)
end
