const assert = require("assert");
const fs = require("fs").promises;
const uuid = require("uuid");

const {
  pipe,
  tap,
  tryCatch,
  assign,
  get,
  eq,
  switchCase,
  map,
} = require("rubico");
const { isEmpty, values, callProp, identity } = require("rubico/x");

const path = require("path");

const runDockerJob = ({ dockerClient, params }) =>
  pipe([
    tap(() => {
      assert(params.name);
      assert(dockerClient, "dockerClient");
    }),
    () => dockerClient.container.create(params),
    () => dockerClient.container.start({ name: params.name }),
    () => dockerClient.container.wait({ name: params.name }),
    tap((xxx) => {
      assert(true);
    }),
  ])();

const gcpConfigFileContent = ({
  credendialFileName,
}) => `const path = require("path");
  module.exports = ({ stage }) => ({
    credentialFile: path.resolve(__dirname, "${credendialFileName}"),
  });`;

const writeGcpFiles = ({
  configFileName,
  credendialFileName,
  credendialContent,
}) =>
  pipe([
    () =>
      fs.writeFile(
        `input/${credendialFileName}`,
        JSON.stringify(credendialContent)
      ),
    () =>
      fs.writeFile(
        configFileName,
        gcpConfigFileContent({ credendialFileName })
      ),
  ])();

const runGcList = ({
  jobId,
  providerAuth,
  provider,
  containerName = "grucloud-cli",
  containerImage = "grucloud-cli",
  localOutputPath = "output",
  localInputPath = "input",
  dockerClient,
  outputDir = "output",
  inputDir = "input",
}) =>
  pipe([
    tap(() => {
      assert(provider);
    }),
    () => ({
      outputGcList: `gc-list-${jobId}.json`,
      outputDot: `${jobId}.dot`,
      outputSvg: `${jobId}.svg`,
    }),
    assign({
      name: () => `${containerName}-${jobId}`,
      Cmd: ({ outputGcList, outputDot }) => [
        "list",
        "--provider",
        provider,
        "--infra",
        `iac_${provider}.js`,
        "--all",
        "--graph",
        "--json",
        `output/${outputGcList}`,
        "--dot-file",
        `output/${outputDot}`,
      ],
      outputGcListLocalPath: ({ outputGcList }) =>
        path.resolve(outputDir, outputGcList),
      outputDotLocalPath: ({ outputDot }) => path.resolve(outputDir, outputDot),
      outputSvgLocalPath: ({ outputSvg }) => path.resolve(outputDir, outputSvg),
      HostConfig: () => ({
        Binds: [
          `${path.resolve(localOutputPath)}:/app/${outputDir}`,
          `${path.resolve(localInputPath)}:/app/${inputDir}`,
        ],
      }),
      Env: () =>
        pipe([
          () => providerAuth,
          map.entries(([key, value]) => [key, `${key}=${value}`]),
          values,
        ])(),
    }),
    switchCase([
      eq(provider, "google"),
      pipe([
        assign({
          Cmd: ({ Cmd }) => [...Cmd, "--config", `input/config-${jobId}.js`],
        }),
        tap(() =>
          writeGcpFiles({
            configFileName: `input/config-${jobId}.js`,
            credendialFileName: `gcp-credendial-${jobId}.json`,
            credendialContent: providerAuth.credentials,
          })
        ),
      ]),
      identity,
    ]),
    tap((input) => {
      //console.log(JSON.stringify(input, null, 4));
    }),
    ({
      name,
      Cmd,
      HostConfig,
      Env,
      outputGcListLocalPath,
      outputSvgLocalPath,
      outputDotLocalPath,
    }) =>
      pipe([
        () => ({
          name,
          body: {
            Image: containerImage,
            Cmd,
            Env,
            HostConfig,
          },
        }),
        tap((xxx) => {
          assert(true);
        }),
        (params) => runDockerJob({ dockerClient, params }),
        assign({
          list: pipe([
            () => fs.readFile(outputGcListLocalPath, "utf-8"),
            JSON.parse,
          ]),
          dot: () => fs.readFile(outputDotLocalPath, "utf-8"),
          svg: () => fs.readFile(outputSvgLocalPath, "utf-8"),
        }),
        tap((content) => {
          console.log(outputGcListLocalPath);
          console.log(JSON.stringify(content, null, 4));
        }),
      ])(),
  ])();

const contextSet400 =
  ({ context, message }) =>
  () => {
    context.status = 400;
    context.body = {
      error: {
        code: 400,
        name: "BadRequest",
        message,
      },
    };
  };

const contextSet404 = ({ context }) => {
  context.status = 404;
  context.body = {
    error: {
      code: 404,
      name: "NotFound",
    },
  };
};

const contextSetOk =
  ({ context }) =>
  (body) => {
    context.status = 200;
    context.body = body;
  };

const getJobStatus = switchCase([
  eq(get("StatusCode"), 0),
  () => "done",
  () => "error",
]);

const getHttpStatus = switchCase([
  eq(get("StatusCode"), 0),
  () => 200,
  () => 422,
]);

exports.DiagramApi = (app) => {
  const log = require("logfilename")(__filename);

  const { models } = app.data.sequelize;
  const { config, dockerClient } = app;
  assert(dockerClient, "dockerClient");
  const { localOutputPath, localInputPath } = config.infra;
  assert(localOutputPath);
  assert(localInputPath);

  const api = {
    pathname: "/cloudDiagram",
    middlewares: [
      app.server.auth.isAuthenticated /*,app.server.auth.isAuthorized*/,
    ],
    ops: {
      getAll: {
        pathname: "/",
        method: "get",
        handler: (context) =>
          tryCatch(
            pipe([
              () =>
                models.Job.findAll({
                  where: { user_id: context.state.user.id },
                }),
              map(callProp("get")),
              contextSetOk({ context }),
            ]),
            pipe([
              (error) => {
                throw error;
              },
            ])
          )(),
      },
      getOne: {
        pathname: "/:id",
        method: "get",
        handler: (context) =>
          tryCatch(
            pipe([
              tap(() => {
                assert(context.params.id);
                assert(context.state.user.id);
              }),
              switchCase([
                () => uuid.validate(context.params.id),
                // valid id
                pipe([
                  () =>
                    models.Job.findOne({
                      where: {
                        id: context.params.id,
                      },
                    }),
                  switchCase([
                    isEmpty,
                    tap(() => contextSet404({ context })),
                    pipe([callProp("get"), contextSetOk({ context })]),
                  ]),
                ]),
                // invalid uuid
                contextSet400({ context, message: "invalid uuid" }),
              ]),
            ]),
            pipe([
              (error) => {
                throw error;
              },
            ])
          )(),
      },
      create: {
        pathname: "/",
        method: "post",
        handler: tryCatch(
          (context) =>
            pipe([
              tap(() => {
                assert(context);
                assert(context.request);
                assert(context.request.body);
                assert(context.request.body.infra_id);
                assert(context.state.user.id);
              }),
              () =>
                models.Infra.findOne({
                  where: {
                    id: context.request.body.infra_id,
                  },
                }),
              tap((xxx) => {
                assert(true);
              }),
              (infra) =>
                pipe([
                  () => ({
                    ...context.request.body,
                    user_id: context.state.user.id,
                    kind: "list",
                    status: "created",
                  }),
                  (params) => models.Job.create(params),
                  ({ id }) =>
                    pipe([
                      tap(() => {
                        assert(id);
                      }),
                      () =>
                        runGcList({
                          jobId: id,
                          providerAuth: infra.providerAuth,
                          provider: infra.providerType,
                          localOutputPath,
                          localInputPath,
                          dockerClient,
                          containerImage: config.infra.containerImage,
                        }),
                      tap((result) =>
                        models.Job.update(
                          { result, status: getJobStatus(result) },
                          { where: { id } }
                        )
                      ),
                      tap((result) => {
                        context.body = result;
                        context.status = getHttpStatus(result);
                      }),
                    ])(),
                ])(),
            ])(),
          pipe([
            tap((error) => {
              log.error(`post error: ${JSON.stringify(error, null, 4)}`);
              throw error;
            }),
          ])
        ),
      },
      delete: {
        pathname: "/:id",
        method: "delete",
        handler: (context) =>
          tryCatch(
            pipe([
              tap(() => {
                assert(context.params.id);
                assert(context.state.user.id);
              }),
              switchCase([
                () => uuid.validate(context.params.id),
                // valid id
                pipe([
                  () =>
                    models.Job.destroy({
                      where: {
                        id: context.params.id,
                        user_id: context.state.user.id,
                      },
                    }),
                  tap(contextSetOk({ context })),
                ]),
                // invalid uuid
                contextSet400({ context, message: "invalid uuid" }),
              ]),
            ]),
            pipe([
              (error) => {
                throw error;
              },
            ])
          )(),
      },

      //update: {
      //   pathname: "/:id",
      //   method: "patch",
      //   handler: async (context) => {
      //     const { id } = context.params;
      //     const user_id = context.state.user.id;
      //     await models.CloudDiagram.update(context.request.body, {
      //       where: {
      //         id,
      //         user_id,
      //       },
      //     });
      //     const cloudDiagram = await models.CloudDiagram.findOne({
      //       where: {
      //         id,
      //         user_id,
      //       },
      //     });
      //     context.body = cloudDiagram.get();
      //     context.status = 200;
      //   },
      // },
    },
  };

  app.server.createRouter(api);
  return { api };
};
