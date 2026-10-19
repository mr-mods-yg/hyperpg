# HyperPG

HyperPG is a lightweight desktop client for browsing PostgreSQL databases. Paste a PostgreSQL connection URL, then explore schemas, tables, columns, and rows in a simple sidebar and table view.

## Download

The latest stable release is **[v1.0.1](https://github.com/mr-mods-yg/hyperpg/releases/tag/v1.0.1)**. Download the build for your system:

- [Windows installer (recommended)](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-windows-amd64-installer.exe)
- [Windows portable executable](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-windows-amd64.exe)
- [Linux x64](https://github.com/mr-mods-yg/hyperpg/releases/latest/download/hyperpg-linux-amd64.tar.gz)
- [All releases, including nightly builds](https://github.com/mr-mods-yg/hyperpg/releases)

The Windows installer sets up HyperPG for the current user, adds Start Menu and desktop shortcuts, and can be removed from Windows Settings. The portable Windows executable needs no installation. On Linux, extract the archive and run `hyperpg`; Linux builds require GTK 4 and WebKitGTK 6.0 at runtime.

## Features

- Browse database schemas, tables, columns, and rows. HyperPG's table browser is read-only.
- Page through table rows and choose how many rows to display.
- Resize the sidebar and collapse schema groups.
- Switch between light and dark themes.
- Save connection details locally in SQLite. Connection URLs are encrypted with AES-GCM, using a key held in the operating system's credential store.
- Receive stable or nightly updates in the app. HyperPG checks at launch, verifies downloaded assets with their SHA-256 digest, and can restart to apply an update. Keep the app in a folder your account can write to.

## Update channels

Choose **Stable** or **Nightly** in Settings. Stable releases use version tags on `master`; the nightly channel tracks prereleases built from `nightly`. A new version can be installed from the in-app update alert.

## Build from source

You need Go 1.25, Node.js 22, and the Wails CLI `v3.0.0-beta.28`. Linux builds also need GTK 4 and WebKitGTK 6.0 development libraries.

```sh
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28
cd frontend
npm ci
cd ..
wails3 dev
```

Build a production app with:

```sh
wails3 build
```

## Releases

- `master` is the stable branch. Stable version tags such as `v1.0.0` must point to a commit on `master`. Before tagging a release, add its dated notes to `CHANGELOG.md` using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
- `nightly` is the prerelease branch. Each push creates a nightly release, and the workflow rebuilds its latest commit daily at 02:17 UTC. Set `master` as the repository's default branch so GitHub runs the scheduled workflow.
- GitHub Actions builds Windows and Linux x64 assets and publishes them on the release page.

See the [changelog](CHANGELOG.md) for release history and the [release workflow](.github/workflows/release.yml) for build details.
