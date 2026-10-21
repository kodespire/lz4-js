# The C++ TurboModule, added to the app's native build by autolinking
# (react-native.config.js). Same sources and defines as binding.gyp.
cmake_minimum_required(VERSION 3.13)
project(kodespire_lz4 C CXX)

set(ROOT ${CMAKE_CURRENT_LIST_DIR}/..)
set(LZ4 ${ROOT}/deps/lz4/lib)

# The files scripts/lz4-sources.cjs lists. Not a glob: lib/lz4file.c is not needed.
add_library(kodespire_lz4 STATIC
  ${ROOT}/cpp/KodespireLz4Module.cpp
  ${ROOT}/csrc/ljs.c
  ${LZ4}/lz4.c
  ${LZ4}/lz4hc.c
  ${LZ4}/lz4frame.c
  ${LZ4}/xxhash.c)

target_include_directories(kodespire_lz4
  PUBLIC ${ROOT}/cpp
  PRIVATE ${ROOT}/csrc ${LZ4})
target_compile_definitions(kodespire_lz4 PRIVATE XXH_NAMESPACE=LZ4_)
# -O3 in debug builds too, like every other build of the package.
target_compile_options(kodespire_lz4 PRIVATE -O3 -fvisibility=hidden)
set_target_properties(kodespire_lz4 PROPERTIES CXX_STANDARD 20 CXX_STANDARD_REQUIRED ON)

target_link_libraries(kodespire_lz4 ReactAndroid::jsi ReactAndroid::reactnative)
