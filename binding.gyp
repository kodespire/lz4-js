{
  "targets": [
    {
      "target_name": "lz4_js",
      "sources": [
        "csrc/addon.cc",
        "csrc/ljs.c",
        "<!@(node scripts/lz4-sources.cjs)"
      ],
      "include_dirs": ["deps/lz4/lib"],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NODE_ADDON_API_DISABLE_DEPRECATED",
        "XXH_NAMESPACE=LZ4_"
      ],
      "cflags": ["-O3", "-fvisibility=hidden"],
      "cflags_cc": ["-O3", "-fvisibility=hidden", "-std=c++17"],
      "xcode_settings": {
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_SYMBOLS_PRIVATE_EXTERN": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "Optimization": 2,
          "AdditionalOptions": ["/std:c++17", "/utf-8"]
        }
      }
    }
  ]
}
