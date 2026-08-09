cmake_minimum_required(VERSION 3.22)

project(obs-extensions VERSION 0.1.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# libobs ships a CMake package with both the OBS SDK and full source builds.
# Point CMAKE_PREFIX_PATH at it when it is not on the default search path, e.g.
#   cmake -B build -DCMAKE_PREFIX_PATH=/path/to/obs-studio/build
find_package(libobs REQUIRED)

add_library(${PROJECT_NAME} MODULE)

target_sources(
  ${PROJECT_NAME}
  PRIVATE src/plugin-main.c
          src/hotkey-vendor.c
          src/hotkey-vendor.h
          src/plugin-support.h
          src/vendor-protocol.h)

# vendor/ holds obs-websocket-api.h, copied verbatim from the obs-websocket
# repository. It is header-only and talks to obs-websocket through the OBS proc
# handler, so there is nothing to link against and no build-time dependency on
# obs-websocket itself.
target_include_directories(${PROJECT_NAME} PRIVATE src vendor)

target_compile_definitions(${PROJECT_NAME} PRIVATE PLUGIN_NAME="${PROJECT_NAME}"
                                                  PLUGIN_VERSION="${PROJECT_VERSION}")

target_link_libraries(${PROJECT_NAME} PRIVATE OBS::libobs)

if(MSVC)
  target_compile_options(${PROJECT_NAME} PRIVATE /W4)
else()
  target_compile_options(${PROJECT_NAME} PRIVATE -Wall -Wextra)
endif()

set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "")

# --- Install ---------------------------------------------------------------
#
# OBS looks for plugins in a different place on every platform. These rules
# cover a system-wide install; see README.md for the per-user paths, which are
# usually the more convenient target during development.

if(APPLE)
  set_target_properties(
    ${PROJECT_NAME}
    PROPERTIES BUNDLE TRUE
               BUNDLE_EXTENSION "plugin"
               MACOSX_BUNDLE_BUNDLE_NAME "${PROJECT_NAME}"
               MACOSX_BUNDLE_BUNDLE_VERSION "${PROJECT_VERSION}"
               MACOSX_BUNDLE_SHORT_VERSION_STRING "${PROJECT_VERSION}"
               MACOSX_BUNDLE_GUI_IDENTIFIER "dev.voidscape.obs-extensions")

  install(TARGETS ${PROJECT_NAME} LIBRARY DESTINATION "$ENV{HOME}/Library/Application Support/obs-studio/plugins")
elseif(WIN32)
  install(TARGETS ${PROJECT_NAME} RUNTIME DESTINATION "obs-plugins/64bit" LIBRARY DESTINATION "obs-plugins/64bit")
  install(DIRECTORY data/ DESTINATION "data/obs-plugins/${PROJECT_NAME}")
else()
  include(GNUInstallDirs)
  install(TARGETS ${PROJECT_NAME} LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}/obs-plugins")
  install(DIRECTORY data/ DESTINATION "${CMAKE_INSTALL_DATAROOTDIR}/obs/obs-plugins/${PROJECT_NAME}")
endif()
