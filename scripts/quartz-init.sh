#!/bin/bash

if [[ ! -d .quartz ]]; then
    git clone git@github.com:jackyzha0/quartz.git .quartz --depth=1
    cd .quartz
    bun install
    rm -rf content
    ln -s ../vault content
    ln -f ../quartz.config.ts quartz.config.ts
    ln -f ../quartz.layout.ts quartz.layout.ts
    cat tsconfig.json | jq '.compilerOptions.paths = {"@quartz/*": ["./quartz/*"]}' > tsconfig.json.tmp
    mv tsconfig.json.tmp tsconfig.json
    cd ..
    rm -rf public
    ln -s .quartz/public public
else
    echo "Dir already exists. Goodbye!"
fi
