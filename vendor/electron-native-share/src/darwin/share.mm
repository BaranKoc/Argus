#import <napi.h>
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

@interface ShareDelegate : NSObject <NSSharingServicePickerDelegate, NSSharingServiceDelegate>
@property (nonatomic, copy) void (^completionHandler)(BOOL success);
@property (nonatomic, copy) NSString *shareTitle;
@end

@implementation ShareDelegate

- (id<NSSharingServiceDelegate>)sharingServicePicker:(NSSharingServicePicker *)picker
                       delegateForSharingService:(NSSharingService *)service {
    if (self.shareTitle) {
        service.subject = self.shareTitle;
    }
    return self;
}

- (void)sharingServicePicker:(NSSharingServicePicker *)sharingServicePicker
     didChooseSharingService:(NSSharingService *)service {
    if (!service && self.completionHandler) {
        self.completionHandler(NO);
    }
}

- (void)sharingService:(NSSharingService *)sharingService
         didShareItems:(NSArray *)items {
    if (self.completionHandler) {
        self.completionHandler(YES);
    }
}

- (void)sharingService:(NSSharingService *)sharingService
    didFailToShareItems:(NSArray *)items
                  error:(NSError *)error {
    if (self.completionHandler) {
        self.completionHandler(NO);
    }
}

@end

static Napi::Value CanShare(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), true);
}

static Napi::Value Share(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected an options object").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object options = info[0].As<Napi::Object>();

    NSMutableArray *shareItems = [NSMutableArray array];

    NSString *shareTitle = nil;
    if (options.Has("title") && options.Get("title").IsString()) {
        std::string title = options.Get("title").As<Napi::String>().Utf8Value();
        shareTitle = [NSString stringWithUTF8String:title.c_str()];
    }

    if (options.Has("text") && options.Get("text").IsString()) {
        std::string text = options.Get("text").As<Napi::String>().Utf8Value();
        NSString *nsText = [NSString stringWithUTF8String:text.c_str()];
        [shareItems addObject:nsText];
    }

    if (options.Has("url") && options.Get("url").IsString()) {
        std::string url = options.Get("url").As<Napi::String>().Utf8Value();
        NSString *urlStr = [NSString stringWithUTF8String:url.c_str()];
        NSURL *nsUrl = [NSURL URLWithString:urlStr];
        if (nsUrl) {
            [shareItems addObject:nsUrl];
        }
    }

    if (options.Has("files") && options.Get("files").IsArray()) {
        Napi::Array files = options.Get("files").As<Napi::Array>();
        for (uint32_t i = 0; i < files.Length(); i++) {
            if (files.Get(i).IsString()) {
                std::string filePath = files.Get(i).As<Napi::String>().Utf8Value();
                NSString *nsPath = [NSString stringWithUTF8String:filePath.c_str()];
                NSURL *fileUrl = [NSURL fileURLWithPath:nsPath];
                if (fileUrl) {
                    [shareItems addObject:fileUrl];
                }
            }
        }
    }

    if ([shareItems count] == 0 && shareTitle) {
        [shareItems addObject:shareTitle];
    }

    if ([shareItems count] == 0) {
        Napi::Error::New(env, "No shareable content provided").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    NSView *handleView = nil;
    if (options.Has("windowHandle") && options.Get("windowHandle").IsBuffer()) {
        auto handleBuf = options.Get("windowHandle").As<Napi::Buffer<uint8_t>>();
        if (handleBuf.Length() >= sizeof(void*)) {
            void *rawPtr = *reinterpret_cast<void**>(handleBuf.Data());
            @try {
                NSView *candidate = (__bridge NSView *)rawPtr;
                if ([candidate isKindOfClass:[NSView class]]) {
                    handleView = candidate;
                }
            } @catch (NSException *) {
                // Invalid pointer — fall through to window discovery
            }
        }
    }

    Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

    Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
        "share_callback",
        0,
        1
    );

    struct CallbackData {
        Napi::Promise::Deferred deferred;
        Napi::ThreadSafeFunction tsfn;
    };

    auto data = new CallbackData{std::move(deferred), std::move(tsfn)};

    NSArray *itemsCopy = [shareItems copy];

    dispatch_async(dispatch_get_main_queue(), ^{
        @autoreleasepool {
            NSWindow *targetWindow = nil;

            if (handleView) {
                targetWindow = [handleView window];
            }

            if (!targetWindow) {
                for (NSWindow *window in [NSApp windows]) {
                    if ([window isKeyWindow]) {
                        targetWindow = window;
                        break;
                    }
                }
            }

            if (!targetWindow && [[NSApp windows] count] > 0) {
                targetWindow = [[NSApp windows] firstObject];
            }

            NSSharingServicePicker *picker = [[NSSharingServicePicker alloc] initWithItems:itemsCopy];

            ShareDelegate *delegate = [[ShareDelegate alloc] init];
            delegate.shareTitle = shareTitle;

            auto captured = data;

            delegate.completionHandler = ^(BOOL success) {
                captured->tsfn.BlockingCall([captured, success](Napi::Env env, Napi::Function) {
                    if (success) {
                        captured->deferred.Resolve(env.Undefined());
                    } else {
                        captured->deferred.Reject(
                            Napi::Error::New(env, "Share cancelled by user").Value()
                        );
                    }
                    captured->tsfn.Release();
                    delete captured;
                });
            };

            picker.delegate = delegate;

            objc_setAssociatedObject(picker, "delegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

            if (targetWindow) {
                NSView *contentView = [targetWindow contentView];
                NSRect bounds = [contentView bounds];
                NSRect rect = NSMakeRect(NSMidX(bounds), NSMidY(bounds), 0, 0);
                [picker showRelativeToRect:rect ofView:contentView preferredEdge:NSMinYEdge];
            } else {
                captured->tsfn.BlockingCall([captured](Napi::Env env, Napi::Function) {
                    captured->deferred.Reject(
                        Napi::Error::New(env, "No window available to present share sheet").Value()
                    );
                    captured->tsfn.Release();
                    delete captured;
                });
            }
        }
    });

    return data->deferred.Promise();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("canShare", Napi::Function::New(env, CanShare));
    exports.Set("share", Napi::Function::New(env, Share));
    return exports;
}

NODE_API_MODULE(native_share, Init)
