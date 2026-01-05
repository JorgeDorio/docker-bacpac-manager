# Docker SQL Bacpac Tool

A Visual Studio Code extension to simplify the process of importing and exporting `.bacpac` files directly to and from SQL Server instances running inside Docker containers.

## Features

* **Import Bacpac**: Easily import a local `.bacpac` file into a SQL Server database inside a running Docker container.
* **Export Bacpac**: Export an existing database from a Docker SQL Server container to a `.bacpac` file on your host machine.
* **Automatic Setup**: Detects if `SqlPackage` is installed in the container and offers an automatic installation if it is missing.
* **Interactive Selection**: Automatically lists running containers and available databases for a seamless workflow.

## Requirements

* **Docker**: Ensure Docker is installed and the daemon is running.
* **SQL Server Container**: A running SQL Server container (Linux-based).
* **Permissions**: The extension may require `root` access within the container to perform automatic installations of tools.

## How to Use

To use this extension, you must use the Command Palette:

1.  Press **`Ctrl+Shift+P`** (or **`Cmd+Shift+P`** on macOS) to open the Command Palette.
2.  Type **"SQL"** to filter the available options.
3.  Select one of the available commands:
    * `SQL: Import Bacpac to Docker`
    * `SQL: Export Bacpac from Docker`
4.  Follow the interactive prompts to select your container, database, and file path.

## Extension Settings

This extension does not require specific VS Code settings. It interacts directly with your local Docker socket using the `dockerode` library.

## Known Issues

* **Large Files**: Copying very large `.bacpac` files into containers may take time depending on your hardware.
* **Permissions**: Automatic installation of `SqlPackage` requires the container to have internet access and the ability to run `apt-get` or `apk` commands.

## Tech Stack

* **Language**: JavaScript.
* **Engine**: VS Code Extension API.
* **Main Dependency**: [dockerode](https://github.com/apocas/dockerode) for Docker socket interaction.

## License

[MIT](LICENSE)

---

**Enjoying the tool?** Feel free to contribute or report issues on the [GitHub Repository](https://github.com/jorgedorio/docker-bacpac-manager).