// Registers the C++ TurboModule with React Native on iOS. Named in package.json's
// codegenConfig.ios.modulesProvider, which codegen turns into a lookup by class name.
#import <Foundation/Foundation.h>
#import <ReactCommon/RCTTurboModule.h>

@interface KodespireLz4ModuleProvider : NSObject <RCTModuleProvider>
@end
