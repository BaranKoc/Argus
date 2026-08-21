#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#include <shobjidl.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.ApplicationModel.DataTransfer.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Foundation.Collections.h>

#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "windowsapp")

using namespace winrt;
using namespace Windows::ApplicationModel::DataTransfer;
using namespace Windows::Storage;
using namespace Windows::Foundation::Collections;

namespace {

// ShowShareUIForWindow is asynchronous: it returns at once and the flyout is filled in
// later by a DataRequested callback, pumped by the message loop of the thread that owns
// the window. So (a) this must run on that thread — the JS main thread, which is
// Electron's UI thread — and (b) the manager plus everything the callback reads has to
// outlive the call, hence the file-static state and the deliberate absence of
// uninit_apartment(). Doing it on a libuv worker and tearing the apartment down right
// after, as this addon originally did, means the sheet opens with nothing attached.
DataTransferManager g_dtm{nullptr};
winrt::event_token g_token{};
std::wstring g_title;
std::wstring g_text;
std::wstring g_url;
IVector<IStorageItem> g_items{nullptr};

std::wstring Widen(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), out.data(), n);
    return out;
}

// GetFileFromPathAsync completes through the STA's message loop, so blocking the STA on
// .get() would deadlock it. Resolve on an MTA thread instead; StorageFile is agile, so the
// callback can hand the results out afterwards.
IVector<IStorageItem> ResolveFiles(const std::vector<std::wstring>& paths) {
    IVector<IStorageItem> items{nullptr};
    std::exception_ptr failure;
    std::thread worker([&] {
        try {
            winrt::init_apartment(winrt::apartment_type::multi_threaded);
            auto vec = winrt::single_threaded_vector<IStorageItem>();
            for (const auto& p : paths) {
                vec.Append(StorageFile::GetFileFromPathAsync(winrt::hstring{p}).get());
            }
            items = vec;
        } catch (...) {
            failure = std::current_exception();
        }
    });
    worker.join();
    if (failure) std::rethrow_exception(failure);
    return items;
}

void EnsureApartment() {
    try {
        winrt::init_apartment(winrt::apartment_type::single_threaded);
    } catch (const winrt::hresult_error& e) {
        // Chromium already initialised COM on this thread; that is fine as long as it is
        // an STA, which is what ShowShareUIForWindow needs.
        if (e.code() != RPC_E_CHANGED_MODE) throw;
    }
}

HWND ExtractHWND(Napi::Buffer<uint8_t> handleBuffer) {
    if (handleBuffer.Length() == sizeof(HWND)) {
        return *reinterpret_cast<HWND*>(handleBuffer.Data());
    }
    return nullptr;
}

}  // namespace

#endif  // _WIN32

static Napi::Value CanShare(const Napi::CallbackInfo& info) {
#ifdef _WIN32
    return Napi::Boolean::New(info.Env(), true);
#else
    return Napi::Boolean::New(info.Env(), false);
#endif
}

static Napi::Value Share(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

#ifdef _WIN32
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected an options object").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object options = info[0].As<Napi::Object>();

    std::string title;
    std::string text;
    std::string url;
    std::vector<std::string> files;
    HWND hwnd = nullptr;

    if (options.Has("title") && options.Get("title").IsString()) {
        title = options.Get("title").As<Napi::String>().Utf8Value();
    }
    if (options.Has("text") && options.Get("text").IsString()) {
        text = options.Get("text").As<Napi::String>().Utf8Value();
    }
    if (options.Has("url") && options.Get("url").IsString()) {
        url = options.Get("url").As<Napi::String>().Utf8Value();
    }
    if (options.Has("files") && options.Get("files").IsArray()) {
        Napi::Array filesArray = options.Get("files").As<Napi::Array>();
        for (uint32_t i = 0; i < filesArray.Length(); i++) {
            if (filesArray.Get(i).IsString()) {
                files.push_back(filesArray.Get(i).As<Napi::String>().Utf8Value());
            }
        }
    }
    if (options.Has("windowHandle") && options.Get("windowHandle").IsBuffer()) {
        hwnd = ExtractHWND(options.Get("windowHandle").As<Napi::Buffer<uint8_t>>());
    }
    if (!hwnd) {
        hwnd = GetForegroundWindow();
    }
    if (!hwnd) {
        Napi::Error::New(env, "No window handle available for sharing")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

    try {
        EnsureApartment();

        g_title = Widen(title);
        g_text = Widen(text);
        g_url = Widen(url);

        if (files.empty()) {
            g_items = nullptr;
        } else {
            std::vector<std::wstring> widePaths;
            widePaths.reserve(files.size());
            for (const auto& f : files) widePaths.push_back(Widen(f));
            g_items = ResolveFiles(widePaths);
        }

        auto interop = winrt::get_activation_factory<DataTransferManager,
                                                     IDataTransferManagerInterop>();

        DataTransferManager dtm{nullptr};
        winrt::check_hresult(interop->GetForWindow(
            hwnd, winrt::guid_of<DataTransferManager>(), winrt::put_abi(dtm)));

        if (g_dtm) g_dtm.DataRequested(g_token);
        g_dtm = dtm;
        g_token = g_dtm.DataRequested(
            [](const DataTransferManager&, const DataRequestedEventArgs& args) {
                auto request = args.Request();
                auto data = request.Data();
                auto props = data.Properties();

                props.Title(g_title.empty() ? winrt::hstring{L"Share"}
                                            : winrt::hstring{g_title});
                if (!g_text.empty()) data.SetText(winrt::hstring{g_text});
                if (!g_url.empty()) {
                    data.SetWebLink(Windows::Foundation::Uri{winrt::hstring{g_url}});
                }
                if (g_items) data.SetStorageItems(g_items);
            });

        // The original ignored this HRESULT, which is why a failed share still reported
        // success. A failure here must reach JS.
        winrt::check_hresult(interop->ShowShareUIForWindow(hwnd));

        deferred.Resolve(env.Undefined());
    } catch (const winrt::hresult_error& e) {
        deferred.Reject(Napi::Error::New(env, winrt::to_string(e.message())).Value());
    } catch (const std::exception& e) {
        deferred.Reject(Napi::Error::New(env, e.what()).Value());
    }

    return deferred.Promise();
#else
    Napi::Error::New(env, "Windows sharing is not supported on this platform")
        .ThrowAsJavaScriptException();
    return env.Undefined();
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("canShare", Napi::Function::New(env, CanShare));
    exports.Set("share", Napi::Function::New(env, Share));
    return exports;
}

NODE_API_MODULE(native_share, Init)
