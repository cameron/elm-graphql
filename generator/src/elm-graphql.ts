const { Elm } = require("./Main.elm");
import * as fs from "fs-extra";
import { GraphQLClient } from "graphql-request";
import * as http from "http";
import * as request from "request";
import { applyElmFormat } from "./formatted-write";
import { introspectionQuery } from "./introspection-query";
import * as glob from "glob";
import * as path from "path";
import * as childProcess from "child_process";
import {
  removeGenerated,
  isGenerated,
  warnAndExitIfContainsNonGenerated
} from "./cli/generated-code-handler";
const npmPackageVersion = require("../../package.json").version;
const elmPackageVersion = require("../../elm.json").version;

const targetComment = `-- Do not manually edit this file, it was auto-generated by dillonkearns/elm-graphql
-- https://github.com/dillonkearns/elm-graphql
`;

const versionMessage = `npm version ${npmPackageVersion}\nTargeting elm package dillonkearns/elm-graphql@${elmPackageVersion}`;

function prependBasePath(
  suffixPath: string,
  baseModule: string[],
  outputPath: string
): string {
  return path.join(outputPath, baseModule.join("/"), suffixPath);
}

let app = Elm.Main.init({ flags: { argv: process.argv, versionMessage } });
// app.ports.print.subscribe(console.log);
app.ports.printAndExitFailure.subscribe((message: string) => {
  console.log(message);
  process.exit(1);
});
app.ports.printAndExitSuccess.subscribe((message: string) => {
  console.log(message);
  process.exit(0);
});

app.ports.introspectSchemaFromFile.subscribe(
  ({
    introspectionFilePath,
    outputPath,
    baseModule
  }: {
    introspectionFilePath: string;
    outputPath: string;
    baseModule: string[];
  }) => {
    warnAndExitIfContainsNonGenerated({ baseModule, outputPath });
    const introspectionFileJson = JSON.parse(
      fs.readFileSync(introspectionFilePath).toString()
    );
    onDataAvailable(
      introspectionFileJson.data || introspectionFileJson,
      outputPath,
      baseModule
    );
  }
);

app.ports.introspectSchemaFromUrl.subscribe(
  ({
    graphqlUrl,
    excludeDeprecated,
    outputPath,
    baseModule,
    headers
  }: {
    graphqlUrl: string;
    excludeDeprecated: boolean;
    outputPath: string;
    baseModule: string[];
    headers: {};
  }) => {
    warnAndExitIfContainsNonGenerated({ baseModule, outputPath });

    console.log("Fetching GraphQL schema...");
    new GraphQLClient(graphqlUrl, {
      mode: "cors",
      headers: headers
    })
      .request(introspectionQuery, { includeDeprecated: !excludeDeprecated })
      .then(data => {
        onDataAvailable(data, outputPath, baseModule);
      })
      .catch(err => {
        console.log(err.response || err);
        process.exit(1);
      });
  }
);

function makeEmptyDirectories(
  baseModule: string[],
  outputPath: string,
  directoryNames: string[]
): void {
  directoryNames.forEach(dir => {
    fs.mkdirpSync(prependBasePath(dir, baseModule, outputPath));
  });
}

function onDataAvailable(data: {}, outputPath: string, baseModule: string[]) {
  console.log("Generating files...");
  app.ports.generatedFiles.subscribe(async function(generatedFile: {
    [s: string]: string;
  }) {
    removeGenerated(prependBasePath("/", baseModule, outputPath));
    makeEmptyDirectories(baseModule, outputPath, [
      "InputObject",
      "Object",
      "Interface",
      "Union",
      "Enum"
    ]);
    await Promise.all(writeGeneratedFiles(outputPath, generatedFile)).catch(
      err => {
        console.error("Error writing files", err);
      }
    );
    writeIntrospectionFile(baseModule, outputPath);
    applyElmFormat(prependBasePath("/", baseModule, outputPath));
    verifyCustomDecodersFileIsValid(outputPath, baseModule);
    console.log("Success!");
  });
  app.ports.generateFiles.send(data);
}

function verifyCustomDecodersFileIsValid(
  outputPath: string,
  baseModule: string[]
) {
  const verifyDecodersFile = path.join(
    outputPath,
    ...baseModule,
    "VerifyScalarDecoders.elm"
  );

  try {
    childProcess.execSync(`elm make ${verifyDecodersFile} --output=/dev/null`, {
      stdio: "pipe"
    });
  } catch (error) {
    console.error(error.message);

    console.error(`--------------------------------------------
INVALID SCALAR DECODERS FILE
--------------------------------------------

Your file is invalid. Check the following:
    * You have a module called \`MyCustomScalarDecoder\`
    * The module is somewhere in your path (check the \`source-directories\` in your \`elm.json\`)

    To get a valid file, you can start by copy-pasting \`Swapi.ScalarDecoders\`. Then change the module name to \`YourCustomThingy\` and you have a valid starting point!

    You must:
    * Have a type for every custom scalar
    * Expose each of these types
    * Expose a \`decoders\` value

    Here are some details that might help you debug the issue. Remember, you can always
    copy-paste \`Swapi.ScalarDecoders\` to get a valid file.

    After you've copy pasted the template file, or tried fixing the file,
    re-run this CLI command to make sure it is valid.
    `);
  }
}

function writeGeneratedFiles(
  outputPath: string,
  generatedFile: {
    [s: string]: string;
  }
): Promise<void>[] {
  return Object.entries(generatedFile).map(([fileName, fileContents]) => {
    const filePath = path.join(outputPath, fileName);
    return fs.writeFile(filePath, targetComment + fileContents);
  });
}

function writeIntrospectionFile(baseModule: string[], outputPath: string) {
  fs.writeFileSync(
    prependBasePath("elm-graphql-metadata.json", baseModule, outputPath),
    `{"targetElmPackageVersion": "${elmPackageVersion}", "generatedByNpmPackageVersion": "${npmPackageVersion}"}`
  );
}
