#import "KodespireLz4ModuleProvider.h"

#import "KodespireLz4Module.h"

@implementation KodespireLz4ModuleProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::KodespireLz4Module>(params.jsInvoker);
}

@end
