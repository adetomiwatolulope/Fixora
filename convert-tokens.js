const fs = require('fs');
const path = require('path');

// Configuration
const inputFilePath = path.join(__dirname, 'design-tokens.tokens (1).json');
const outputFilePath = path.join(__dirname, 'design-tokens.css');

function formatVariableName(pathArray) {
    // Convert array of keys into a CSS variable name
    // e.g., ['primitives', 'primary colors', 'primary 10'] -> '--primitives-primary-colors-primary-10'
    const formatted = pathArray.map(key => key.toLowerCase().replace(/[\s_]+/g, '-')).join('-');
    return `--${formatted}`;
}

function processValue(value) {
    if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
        // It's a reference to another token, e.g., {primitives.primary colors.primary 40}
        const refPath = value.slice(1, -1); // Remove { and }
        const formattedRef = refPath.split('.').map(key => key.toLowerCase().replace(/[\s_]+/g, '-')).join('-');
        return `var(--${formattedRef})`;
    }
    
    // Add logic here if specific type formatting is required (like shadows or typography)
    return value;
}

function extractTokens(node, pathArray = [], tokens = []) {
    if (typeof node !== 'object' || node === null) {
        return tokens;
    }

    if (node.value !== undefined) {
        // It's a token
        
        // Handle specific types like custom-shadow or typography if needed
        let cssValue = '';
        if (typeof node.value === 'object') {
            if (node.type === 'custom-shadow') {
                cssValue = `${node.value.offsetX}px ${node.value.offsetY}px ${node.value.radius}px ${node.value.spread}px ${node.value.color}`;
            } else {
                // Ignore other objects for this basic script, or handle typography, etc.
                return tokens;
            }
        } else {
            cssValue = processValue(node.value);
        }

        tokens.push({
            name: formatVariableName(pathArray),
            value: cssValue,
            type: node.type,
            description: node.description || ''
        });
    } else {
        // It's a group, recurse
        for (const [key, value] of Object.entries(node)) {
            // Skip extensions and description if they are objects at the same level
            if (key === 'extensions' || key === 'description') continue;
            extractTokens(value, [...pathArray, key], tokens);
        }
    }
    return tokens;
}

function main() {
    console.log('Reading design tokens from:', inputFilePath);
    const data = JSON.parse(fs.readFileSync(inputFilePath, 'utf8'));

    const tokens = extractTokens(data);

    let cssContent = `/* 
 * Design System Tokens 
 * Auto-generated CSS variables from design-tokens.tokens (1).json
 */\n\n:root {\n`;

    // Separate tokens into categories for better documentation
    const primitives = tokens.filter(t => t.name.startsWith('--primitives'));
    const colorRoles = tokens.filter(t => t.name.startsWith('--color-roles'));
    const otherTokens = tokens.filter(t => !t.name.startsWith('--primitives') && !t.name.startsWith('--color-roles'));

    cssContent += `  /* ==========================================\n`;
    cssContent += `   * PRIMITIVE COLOURS\n`;
    cssContent += `   * Foundational colours not to be applied directly on the UI.\n`;
    cssContent += `   * ========================================== */\n`;
    primitives.forEach(token => {
        cssContent += `  ${token.name}: ${token.value}; ${token.description ? `/* ${token.description} */` : ''}\n`;
    });

    cssContent += `\n  /* ==========================================\n`;
    cssContent += `   * COLOUR ROLES\n`;
    cssContent += `   * Semantic colours applied directly on the UI.\n`;
    cssContent += `   * ========================================== */\n`;
    colorRoles.forEach(token => {
        cssContent += `  ${token.name}: ${token.value}; ${token.description ? `/* ${token.description} */` : ''}\n`;
    });

    if (otherTokens.length > 0) {
        cssContent += `\n  /* ==========================================\n`;
        cssContent += `   * OTHER TOKENS (Typography, Spacing, Effects)\n`;
        cssContent += `   * ========================================== */\n`;
        otherTokens.forEach(token => {
            cssContent += `  ${token.name}: ${token.value}; ${token.description ? `/* ${token.description} */` : ''}\n`;
        });
    }

    cssContent += `}\n`;

    fs.writeFileSync(outputFilePath, cssContent, 'utf8');
    console.log('Successfully generated CSS variables at:', outputFilePath);
}

main();
