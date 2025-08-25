#include "html_converter.h"
#include <memory>
#include <string>

Napi::FunctionReference HtmlConverter::constructor;

Napi::Object HtmlConverter::Init(Napi::Env env, Napi::Object exports) {
    Napi::HandleScope scope(env);

    Napi::Function func = DefineClass(env, "HtmlConverter", {
        InstanceMethod("convert", &HtmlConverter::Convert),
        InstanceMethod("convertSync", &HtmlConverter::ConvertSync),
        StaticMethod("createNew", &HtmlConverter::CreateNew)
    });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();

    exports.Set("HtmlConverter", func);
    
    // Also export a simple function interface
    exports.Set("convertSync", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
        Napi::Env env = info.Env();
        
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
            return env.Null();
        }

        std::string html = info[0].As<Napi::String>().Utf8Value();
        char* result = ConvertHTMLToMarkdown(html.c_str());
        
        if (result == nullptr) {
            Napi::Error::New(env, "Failed to convert HTML to Markdown").ThrowAsJavaScriptException();
            return env.Null();
        }

        std::string markdown(result);
        FreeString(result);

        return Napi::String::New(env, markdown);
    }));

    return exports;
}

HtmlConverter::HtmlConverter(const Napi::CallbackInfo& info) : Napi::ObjectWrap<HtmlConverter>(info) {
    // Constructor implementation
}

Napi::Value HtmlConverter::CreateNew(const Napi::CallbackInfo& info) {
    return constructor.New({});
}

class ConvertAsyncWorker : public Napi::AsyncWorker {
public:
    ConvertAsyncWorker(Napi::Function& callback, const std::string& html)
        : Napi::AsyncWorker(callback), html_(html) {}

    ~ConvertAsyncWorker() {}

    void Execute() override {
        char* result = ConvertHTMLToMarkdown(html_.c_str());
        if (result != nullptr) {
            result_ = std::string(result);
            FreeString(result);
        } else {
            SetError("Failed to convert HTML to Markdown");
        }
    }

    void OnOK() override {
        Napi::HandleScope scope(Env());
        Callback().Call({Env().Null(), Napi::String::New(Env(), result_)});
    }

private:
    std::string html_;
    std::string result_;
};

Napi::Value HtmlConverter::Convert(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected html string and callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string as first argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (!info[1].IsFunction()) {
        Napi::TypeError::New(env, "Expected function as second argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string html = info[0].As<Napi::String>().Utf8Value();
    Napi::Function callback = info[1].As<Napi::Function>();

    ConvertAsyncWorker* worker = new ConvertAsyncWorker(callback, html);
    worker->Queue();

    return env.Undefined();
}

Napi::Value HtmlConverter::ConvertSync(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected string argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string html = info[0].As<Napi::String>().Utf8Value();
    char* result = ConvertHTMLToMarkdown(html.c_str());
    
    if (result == nullptr) {
        Napi::Error::New(env, "Failed to convert HTML to Markdown").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string markdown(result);
    FreeString(result);

    return Napi::String::New(env, markdown);
}