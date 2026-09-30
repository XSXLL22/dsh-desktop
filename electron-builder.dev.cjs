const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  appId: 'io.bisheng.work.dev',
  productName: 'BISHENG Dev',
  protocols: [
    {
      name: 'BISHENG Enterprise Login',
      schemes: ['bisheng-work-dev']
    }
  ],
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'dsh-desktop-dev',
    productName: 'BISHENG Dev',
    dshDesktopChannel: 'development'
  },
  artifactName: 'bisheng-work-dev-${os}-${arch}.${ext}',
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'bisheng-work-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}
