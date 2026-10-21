package com.kodespire.lz4;

import androidx.annotation.Nullable;
import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import java.util.HashMap;

/**
 * Autolinking links a library through its package class. The module itself is C++
 * (cpp/KodespireLz4Module.cpp), registered by react-native.config.js, so this
 * package provides nothing from Java.
 */
public class KodespireLz4Package extends BaseReactPackage {
  @Nullable
  @Override
  public NativeModule getModule(String name, ReactApplicationContext reactContext) {
    return null;
  }

  @Override
  public ReactModuleInfoProvider getReactModuleInfoProvider() {
    return HashMap::new;
  }
}
