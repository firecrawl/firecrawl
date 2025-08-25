#ifndef HTML_CONVERTER_H
#define HTML_CONVERTER_H

#include <napi.h>

// C interface to Go library
extern "C" {
    char* ConvertHTMLToMarkdown(const char* html);
    void FreeString(char* str);
}

class HtmlConverter : public Napi::ObjectWrap<HtmlConverter> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    static Napi::FunctionReference constructor;

    HtmlConverter(const Napi::CallbackInfo& info);

private:
    static Napi::Value CreateNew(const Napi::CallbackInfo& info);
    Napi::Value Convert(const Napi::CallbackInfo& info);
    Napi::Value ConvertSync(const Napi::CallbackInfo& info);
};

#endif