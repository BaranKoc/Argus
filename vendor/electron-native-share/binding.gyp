{
  "targets": [
    {
      "target_name": "native_share",
      "sources": [],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        ["OS=='mac'", {
          "sources": [
            "src/darwin/share.mm"
          ],
          "xcode_settings": {
            "GCC_ENABLE_OBJC_EXCEPTIONS": "YES",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-ObjC++"
            ],
            "MACOSX_DEPLOYMENT_TARGET": "10.14"
          },
          "link_settings": {
            "libraries": [
              "-framework Cocoa",
              "-framework AppKit"
            ]
          }
        }],
        ["OS=='win'", {
          "sources": [
            "src/win32/share.cpp"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": [
                "/std:c++17",
                "/await"
              ],
              "ExceptionHandling": 1
            }
          },
          "libraries": [
            "-lwindowsapp"
          ],
          "defines": [
            "WINRT_LEAN_AND_MEAN"
          ]
        }]
      ]
    }
  ]
}
