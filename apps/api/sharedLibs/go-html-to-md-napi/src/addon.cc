#include <napi.h>
#include "html_converter.h"

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return HtmlConverter::Init(env, exports);
}

NODE_API_MODULE(html_to_markdown, Init)