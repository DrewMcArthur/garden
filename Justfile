[working-directory: ".quartz"]
quartz *args:
    @bun quartz/bootstrap-cli.mjs {{args}}

[script]
quartz-init:
    git clone git@github.com:jackyzha0/quartz.git .quartz --depth=1
    cd .quartz
    bun install
    rm -rf content
    ln -s ../vault content
    ln -s ../public public
    ln -f ../quartz.config.ts quartz.config.ts
    ln -f ../quartz.layout.ts quartz.layout.ts
    cat tsconfig.json | jq '.compilerOptions.paths = {"@quartz/*": ["./quartz/*"]}' > tsconfig.json.tmp
    mv tsconfig.json.tmp tsconfig.json
    cd ..
    rm -rf public
    ln -s .quartz/public public
