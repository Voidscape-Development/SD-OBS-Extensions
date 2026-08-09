cmake_minimum_required(VERSION 3.28...3.30)

include("${CMAKE_CURRENT_SOURCE_DIR}/cmake/common/bootstrap.cmake" NO_POLICY_SCOPE)

project(${_name} VERSION ${_version})

# This plugin adds nothing to the OBS interface and links only libobs, so both
# the frontend API and Qt stay off. Qt is still fetched by the shared buildspec
# handling in cmake/, but nothing links against it.
option(ENABLE_FRONTEND_API "Use obs-frontend-api for UI functionality" OFF)
option(ENABLE_QT "Use Qt functionality" OFF)

include(compilerconfig)
include(defaults)
include(helpers)

add_library(${CMAKE_PROJECT_NAME} MODULE)

find_package(libobs REQUIRED)
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE OBS::libobs)

target_sources(
  ${CMAKE_PROJECT_NAME}
  PRIVATE src/plugin-main.c src/hotkey-vendor.c src/hotkey-vendor.h src/plugin-support.h src/vendor-protocol.h
)

# vendor/ holds obs-websocket-api.h, copied verbatim from the obs-websocket
# repository. It is header-only and reaches obs-websocket through the OBS proc
# handler at runtime, so there is nothing to link against and no build-time
# dependency on obs-websocket itself.
target_include_directories(
  ${CMAKE_PROJECT_NAME}
  PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src" "${CMAKE_CURRENT_SOURCE_DIR}/vendor"
)

target_compile_definitions(
  ${CMAKE_PROJECT_NAME}
  PRIVATE PLUGIN_NAME="${CMAKE_PROJECT_NAME}" PLUGIN_VERSION="${PLUGIN_VERSION}"
)

set_target_properties_plugin(${CMAKE_PROJECT_NAME} PROPERTIES OUTPUT_NAME ${_name})
