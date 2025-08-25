{
  "targets": [
    {
      "target_name": "html_to_markdown",
      "sources": [
        "src/addon.cc",
        "src/html_converter.cc"
      ],
      "include_dirs": [
        "<!(node -e \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -e \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "MACOSX_DEPLOYMENT_TARGET": "10.7"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      },
      "conditions": [
        ["OS=='linux'", {
          "libraries": [
            "<(module_root_dir)/lib/libhtml_converter.a"
          ]
        }],
        ["OS=='mac'", {
          "libraries": [
            "<(module_root_dir)/lib/libhtml_converter.a"
          ]
        }]
      ]
    }
  ]
}