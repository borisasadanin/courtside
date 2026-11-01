#!/bin/sh
# Prepare a camera app release: camera/release.sh 1.2.0
#
# Sets the release version and counts the build number up, in project.yml and,
# when it has been generated, in the Xcode project. Editing the project rather
# than running xcodegen keeps what was set in Xcode, such as the signing team.
set -eu
cd "$(dirname "$0")"

version="${1:-}"
if ! echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "Ange versionen, t.ex.: camera/release.sh 1.2.0" >&2
  exit 1
fi
if ! grep -q "^## $version " CHANGELOG.md; then
  echo "Lägg först till ett avsnitt '## $version — datum' i camera/CHANGELOG.md" >&2
  exit 1
fi

build=$(sed -n 's/^ *CURRENT_PROJECT_VERSION: *//p' project.yml)
build=$((build + 1))

sed -i '' \
  -e "s/^\( *MARKETING_VERSION:\).*/\1 $version/" \
  -e "s/^\( *CURRENT_PROJECT_VERSION:\).*/\1 $build/" \
  project.yml

pbxproj=CourtsideCamera.xcodeproj/project.pbxproj
if [ -f "$pbxproj" ]; then
  sed -i '' \
    -e "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $version;/" \
    -e "s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = $build;/" \
    "$pbxproj"
fi

echo "Kameraappen $version, bygge $build."
echo "Bygg och installera, checka sedan in och tagga: git tag camera-v$version"
