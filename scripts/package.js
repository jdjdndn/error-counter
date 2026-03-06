const fs = require('fs');
const path = require('path');

// Simple VSIX packager for Node.js 18 compatibility
// VSIX is a ZIP file with specific structure

const projectRoot = path.join(__dirname, '..');
const outDir = path.join(projectRoot, 'out');
const packageJsonPath = path.join(projectRoot, 'package.json');

// Read package.json
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Auto-increment version (patch)
function incrementVersion(version) {
    const parts = version.split('.').map(Number);
    if (parts.length === 3) {
        parts[2]++; // Increment patch version
        return parts.join('.');
    }
    return version;
}

// Increment version and save back to package.json
const oldVersion = packageJson.version;
const newVersion = incrementVersion(oldVersion);
packageJson.version = newVersion;

// Save updated package.json
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf8');
console.log(`Version: ${oldVersion} -> ${newVersion}`);

// Parse .vscodeignore file
function parseIgnoreFile(ignoreFilePath) {
    if (!fs.existsSync(ignoreFilePath)) {
        return [];
    }

    const content = fs.readFileSync(ignoreFilePath, 'utf8');
    const patterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

    return patterns;
}

// Convert glob pattern to regex
function globToRegex(pattern) {
    // Handle negation
    const isNegation = pattern.startsWith('!');
    if (isNegation) {
        pattern = pattern.substring(1);
    }

    // Escape special regex characters except * and ?
    let regex = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '<<DOUBLESTAR>>')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/<<DOUBLESTAR>>/g, '.*')
        .replace(/\?/g, '[^/\\\\]');

    // Handle directory patterns
    if (regex.endsWith('/')) {
        regex = regex.slice(0, -1) + '(/.*)?';
    }

    // For patterns starting with *, match anywhere in path
    if (pattern.startsWith('*')) {
        return {
            regex: new RegExp(regex + '$', 'i'),
            isNegation
        };
    }

    return {
        regex: new RegExp('^' + regex + '$', 'i'),
        isNegation
    };
}

// Check if a path should be ignored
function shouldIgnore(filePath, ignorePatterns) {
    const relativePath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    let ignored = false;

    for (const { regex, isNegation } of ignorePatterns) {
        if (regex.test(relativePath) || regex.test(relativePath + '/')) {
            ignored = !isNegation;
        }
    }

    return ignored;
}

// Build ignore patterns
const ignorePatterns = parseIgnoreFile(path.join(projectRoot, '.vscodeignore')).map(globToRegex);
console.log('Ignore patterns loaded:', ignorePatterns.length);

// Create VSIX manifest
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${packageJson.name}" Version="${packageJson.version}" Publisher="${packageJson.publisher}"/>
    <DisplayName>${packageJson.displayName}</DisplayName>
    <Description xml:space="preserve">${packageJson.description}</Description>
    <Tags>vscode,extension,error,counter</Tags>
    <GalleryFlags>Public</GalleryFlags>
    <InstalledByMsi>False</InstalledByMsi>
    <SupportedProducts>
      <VisualStudio Version="17.0">
        <Edition>Pro</Edition>
      </VisualStudio>
    </SupportedProducts>
    <PreviewImage></PreviewImage>
    <Icon></Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="package.json"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="README.md"/>
  </Assets>
</PackageManifest>`;

// Simple ZIP file creation (without external dependencies)
// This is a minimal implementation that creates a valid ZIP file

class SimpleZip {
    constructor() {
        this.files = [];
    }

    addFile(name, content) {
        this.files.push({ name, content: Buffer.isBuffer(content) ? content : Buffer.from(content) });
    }

    addDirectory(name) {
        this.files.push({ name: name.endsWith('/') ? name : name + '/', content: Buffer.alloc(0), isDirectory: true });
    }

    generate() {
        const localFileHeaders = [];
        const centralDirectoryHeaders = [];
        let offset = 0;

        // Add files
        for (const file of this.files) {
            const nameBuffer = Buffer.from(file.name, 'utf8');
            const content = file.content;
            const isDirectory = file.isDirectory || file.name.endsWith('/');

            // Local file header
            const localHeader = Buffer.alloc(30 + nameBuffer.length);
            localHeader.writeUInt32LE(0x04034b50, 0); // Signature
            localHeader.writeUInt16LE(20, 4); // Version needed
            localHeader.writeUInt16LE(0, 6); // General purpose flag
            localHeader.writeUInt16LE(0, 8); // Compression (0 = stored)
            localHeader.writeUInt16LE(0, 10); // File time
            localHeader.writeUInt16LE(0, 12); // File date
            localHeader.writeUInt32LE(this.crc32(content), 14); // CRC-32
            localHeader.writeUInt32LE(isDirectory ? 0 : content.length, 18); // Compressed size
            localHeader.writeUInt32LE(isDirectory ? 0 : content.length, 22); // Uncompressed size
            localHeader.writeUInt16LE(nameBuffer.length, 26); // Filename length
            localHeader.writeUInt16LE(0, 28); // Extra field length
            nameBuffer.copy(localHeader, 30);

            localFileHeaders.push({
                header: localHeader,
                data: isDirectory ? Buffer.alloc(0) : content,
                offset: offset
            });

            offset += localHeader.length + (isDirectory ? 0 : content.length);

            // Central directory header
            const centralHeader = Buffer.alloc(46 + nameBuffer.length);
            centralHeader.writeUInt32LE(0x02014b50, 0); // Signature
            centralHeader.writeUInt16LE(20, 4); // Version made by
            centralHeader.writeUInt16LE(20, 6); // Version needed
            centralHeader.writeUInt16LE(0, 8); // General purpose flag
            centralHeader.writeUInt16LE(0, 10); // Compression
            centralHeader.writeUInt16LE(0, 12); // File time
            centralHeader.writeUInt16LE(0, 14); // File date
            centralHeader.writeUInt32LE(this.crc32(content), 16); // CRC-32
            centralHeader.writeUInt32LE(isDirectory ? 0 : content.length, 20); // Compressed size
            centralHeader.writeUInt32LE(isDirectory ? 0 : content.length, 24); // Uncompressed size
            centralHeader.writeUInt16LE(nameBuffer.length, 28); // Filename length
            centralHeader.writeUInt16LE(0, 30); // Extra field length
            centralHeader.writeUInt16LE(0, 32); // Comment length
            centralHeader.writeUInt16LE(0, 34); // Disk number
            centralHeader.writeUInt16LE(0, 36); // Internal attributes
            centralHeader.writeUInt32LE(isDirectory ? 0x10 : 0, 38); // External attributes
            centralHeader.writeUInt32LE(localFileHeaders[localFileHeaders.length - 1].offset, 42); // Relative offset
            nameBuffer.copy(centralHeader, 46);

            centralDirectoryHeaders.push(centralHeader);
        }

        const centralDirOffset = offset;
        let centralDirSize = 0;

        // Calculate central directory size
        for (const header of centralDirectoryHeaders) {
            centralDirSize += header.length;
        }

        // End of central directory record
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0); // Signature
        eocd.writeUInt16LE(0, 4); // Disk number
        eocd.writeUInt16LE(0, 6); // Disk with central directory
        eocd.writeUInt16LE(this.files.length, 8); // Number of entries on disk
        eocd.writeUInt16LE(this.files.length, 10); // Total number of entries
        eocd.writeUInt32LE(centralDirSize, 12); // Central directory size
        eocd.writeUInt32LE(centralDirOffset, 16); // Central directory offset
        eocd.writeUInt16LE(0, 20); // Comment length

        // Combine all parts
        const parts = [];
        for (const item of localFileHeaders) {
            parts.push(item.header);
            parts.push(item.data);
        }
        for (const header of centralDirectoryHeaders) {
            parts.push(header);
        }
        parts.push(eocd);

        return Buffer.concat(parts);
    }

    crc32(data) {
        // Simple CRC-32 implementation
        const table = this.getCRC32Table();
        let crc = 0xffffffff;
        for (let i = 0; i < data.length; i++) {
            crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    getCRC32Table() {
        if (!SimpleZip.crc32Table) {
            const table = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                let c = i;
                for (let j = 0; j < 8; j++) {
                    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                }
                table[i] = c;
            }
            SimpleZip.crc32Table = table;
        }
        return SimpleZip.crc32Table;
    }
}

// Recursively add files from directory
function addDirectoryToZip(zip, dirPath, zipPath) {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
        const fullPath = path.join(dirPath, item);

        // Check ignore patterns
        if (shouldIgnore(fullPath, ignorePatterns)) {
            continue;
        }

        const fullZipPath = path.join(zipPath, item).replace(/\\/g, '/');
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            zip.addDirectory(fullZipPath + '/');
            addDirectoryToZip(zip, fullPath, fullZipPath);
        } else {
            const content = fs.readFileSync(fullPath);
            zip.addFile(fullZipPath, content);
        }
    }
}

// Create the ZIP
const zip = new SimpleZip();

// Add extension.vsixmanifest (root level)
zip.addFile('extension.vsixmanifest', manifest);

// Add package.json to extension folder
zip.addFile('extension/package.json', JSON.stringify(packageJson, null, 2));

// Add README.md to extension folder if exists and not ignored
const readmePath = path.join(projectRoot, 'README.md');
if (fs.existsSync(readmePath) && !shouldIgnore(readmePath, ignorePatterns)) {
    zip.addFile('extension/README.md', fs.readFileSync(readmePath));
}

// Add out directory to extension folder
if (fs.existsSync(outDir)) {
    addDirectoryToZip(zip, outDir, 'extension/out');
} else {
    console.error('Error: out directory not found. Run npm run compile first.');
    process.exit(1);
}

// Add resources directory to extension folder if exists and not ignored
const resourcesPath = path.join(projectRoot, 'resources');
if (fs.existsSync(resourcesPath) && !shouldIgnore(resourcesPath, ignorePatterns)) {
    addDirectoryToZip(zip, resourcesPath, 'extension/resources');
}

// Generate and save
const vsixContent = zip.generate();
const outputPath = path.join(projectRoot, `${packageJson.name}-${packageJson.version}.vsix`);
fs.writeFileSync(outputPath, vsixContent);

console.log(`Created: ${outputPath}`);
console.log(`Size: ${(vsixContent.length / 1024).toFixed(2)} KB`);
