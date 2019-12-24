"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const path_1 = require("path");
module.exports = new class {
    constructor() {
        this.meta = {
            type: 'problem',
            schema: {},
            messages: {
                layerbreaker: 'Bad layering. You are not allowed to access {{from}} from here, allowed layers are: [{{allowed}}]'
            }
        };
    }
    create(context) {
        const fileDirname = path_1.dirname(context.getFilename());
        const parts = fileDirname.split(/\\|\//);
        const ruleArgs = context.options[0];
        let config;
        for (let i = parts.length - 1; i >= 0; i--) {
            if (ruleArgs[parts[i]]) {
                config = {
                    allowed: new Set(ruleArgs[parts[i]]).add(parts[i]),
                    disallowed: new Set()
                };
                Object.keys(ruleArgs).forEach(key => {
                    if (!config.allowed.has(key)) {
                        config.disallowed.add(key);
                    }
                });
                break;
            }
        }
        if (!config) {
            // nothing
            return {};
        }
        return {
            ImportDeclaration: (node) => {
                this._checkImport(context, config, node, node.source.value);
            },
            CallExpression: (node) => {
                var _a;
                const { callee, arguments: args } = node;
                if (callee.type === 'Import' && ((_a = args[0]) === null || _a === void 0 ? void 0 : _a.type) === 'Literal') {
                    this._checkImport(context, config, node, args[0].value);
                }
            }
        };
    }
    _checkImport(context, config, node, path) {
        if (typeof path !== 'string') {
            return;
        }
        if (path[0] === '.') {
            path = path_1.join(path_1.dirname(context.getFilename()), path);
        }
        const parts = path_1.dirname(path).split(/\\|\//);
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (config.allowed.has(part)) {
                // GOOD - same layer
                break;
            }
            if (config.disallowed.has(part)) {
                // BAD - wrong layer
                context.report({
                    node,
                    messageId: 'layerbreaker',
                    data: {
                        from: part,
                        allowed: [...config.allowed.keys()].join(', ')
                    }
                });
                break;
            }
        }
    }
};