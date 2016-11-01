'use strict'

const fs = require('fs')
const Metalsmith = require('metalsmith')
const jade = require('metalsmith-jade')
const markdown = require('metalsmith-markdown')
const layouts = require('metalsmith-layouts')
const permalinks = require('metalsmith-permalinks')
const bourbon = require('node-bourbon')
const path = require('path')
const autoprefixer = require('autoprefixer')
const each = require('metalsmith-each')
const navigation = require('metalsmith-navigation')
const modRewrite = require('connect-modrewrite')
const define = require('metalsmith-define')
const collections = require('metalsmith-collections')
const writemetadata = require('metalsmith-writemetadata')
const moment = require('moment')
const tags = require('metalsmith-tags')
const mlunr = require('metalsmith-lunr')
const feed = require('metalsmith-feed')
const gulpsmith = require('gulpsmith')
const gulp = require('gulp')
const watch = require('gulp-watch')
const plumber = require('gulp-plumber')
const batch = require('gulp-batch')
const browserSync = require('browser-sync').create()
const reload = browserSync.reload
const gulpLoadPlugins = require('gulp-load-plugins')
const $ = gulpLoadPlugins()
const CONFIG = require('./env.json')[process.env.NODE_ENV] || require('./env.json')['production']

//
// general build settings
//

const currentVersion = '1.8'
const docsVersions = ['1.7', '1.8', '1.9']
const cssTimestamp = new Date().getTime()
const paths = {
  build: './build',
  blog: {
    src: 'src/blog/*.md'
  },
  styles: {
    src: './src/styles/**/*.scss',
    dest: './build/styles'
  },
  js: {
    src: './src/scripts/**/*.js',
    dest: './build/scripts'
  },
  assets: {
    src: './src/assets/**/*.*',
    dest: './build/assets'
  }
}

const navConfig = {
  header: {
    includeDirs: true,
    pathProperty: 'nav_path',
    childrenProperty: 'nav_children',
    sortBy: function (file, node) {
      if (file !== undefined) {
        if (file.menu_order !== undefined) {
          return file.menu_order
        }
      } else if (node.type === 'dir') {
        // for directories find the index.html and grab its menu_order
        let indexFile = node.children.find((c) => c.name == 'index.html')
        if (indexFile !== undefined) {
          if (indexFile.file.menu_order !== undefined) {
            return indexFile.file.menu_order
          }
        }
      }
      return 999
    },
    sortByNameFirst: true
  }
}

let createDocsJSON = function (obj) {
  var newObj = {
    name: obj.type,
    path: obj.path
  }

  if (obj.file) {
    newObj.file = {
      post_title: obj.file.nav_title || obj.file.post_title,
      search_blurb: obj.file.search_blurb
    }
  }
  newObj.children = obj.children.map(createDocsJSON)

  return newObj
}

const navSettings = {
  navListProperty: 'navs',
  permalinks: false,
  formatJSONfn: createDocsJSON
}

let nav = navigation(navConfig, navSettings)

//
// Gulp tasks
//

gulp.task('build', ['build-site', ...docsVersions.map(getDocsBuildTask), 'build-blog', ...docsVersions.map(getDocsCopyTask), 'copy', 'javascript', 'styles'])

gulp.task('serve', ['build'], () => {
  browserSync.init({
    open: false,
    server: {
      baseDir: paths.build,
      middleware: [
        modRewrite([
          '^/docs/latest/(.*) /docs/' + currentVersion + '/$1'
        ]),
        function (req, res, next) {
          var file = `./build${req.originalUrl}.html`
          require('fs').exists(file, function (exists) {
            if (exists) req.url += '.html'
            next()
          })
        }
      ]
    }
  })

  watch(['./src/**/*.jade', './src/*.md', './src/events.json'],
    batch(function (events, done) { gulp.start('build-site', done) }))
  watch(paths.blog.src,
    batch(function (events, done) { gulp.start('build-blog', done) }))
  watch(paths.styles.src,
    batch(function (events, done) { gulp.start('styles', done) }))
  watch(paths.js.src,
    batch(function (events, done) { gulp.start('js-watch', done) }))
  watch(paths.assets.src,
    batch(function (events, done) { gulp.start('copy', done) }))
  watch(['./layouts/**/*.*', './mixins/**/*.*', './includes/**/*.*'],
    batch(function (events, done) {
      gulp.start(['build-site', 'build-blog'], done)
    }))

  docsVersions.forEach(function (version) {
    watch(`./dcos-docs/${version}/**/*.md`, batch(function (events, done) {
      gulp.start(`build-docs-${version}`, done)
    }))
  })
})

gulp.task('test', ['serve'], () => {
  process.exit(0)
})

function getDocsBuildTask (version) {
  const name = `build-docs-${version}`
  const src = `./dcos-docs/${version}/**/*.md`

  gulp.task(name, () => {
    return gulp.src(src)
      .pipe($.frontMatter().on('data', file => {
        Object.assign(file, file.frontMatter)
        delete file.frontMatter
      }))
      .pipe(
        gulpsmith()
          .metadata({ docsVersion: version, docsVersions })
          .use(addTimestampToMarkdownFiles)
          .use(markdown({
            smartypants: true,
            gfm: true,
            tables: true
          }))
          .use(nav)
          .use(layouts({
            pattern: '**/*.html',
            engine: 'jade',
            directory: path.join('layouts'),
            default: 'docs.jade'
          }))
          .use(each(updatePaths))
          .use(jade({
            locals: { cssTimestamp, docsVersions },
            useMetadata: true,
            pretty: true
          }))
          .use(reloadInMetalsmithPipeline)
      )
      .pipe(gulp.dest(path.join(paths.build, 'docs', version)))
  })

  return name
}

function getDocsCopyTask (version) {
  const name = `copy-docs-images-${version}`

  gulp.task(name, () => {
    return gulp.src(`./dcos-docs/${version}/**/*.{png,gif,jpg,jpeg,json,sh}`)
      .pipe(gulp.dest(path.join(paths.build, 'docs', version)))
  })

  return name
}

gulp.task('build-blog', () => {
  return gulp.src(paths.blog.src)
    .pipe($.frontMatter().on('data', file => {
      Object.assign(file, file.frontMatter)
      delete file.frontMatter
    }))
    .pipe(
      gulpsmith()
        .metadata({
          site: {
            url: CONFIG.root_url
          }
        })
        .use(addTimestampToMarkdownFiles)
        .use(markdown({
          smartypants: true,
          gfm: true,
          tables: true
        }))
        .use(jade({
          locals: { cssTimestamp },
          pretty: true
        }))
        .use(permalinks({
          pattern: ':title',
          date: 'YYYY',
          linksets: [{
            match: { collection: 'posts' },
            pattern: 'blog/:date/:title'
          }]
        }))
        .use(collections({
          posts: {
            pattern: '*.md',
            sortBy: 'date',
            reverse: true
          }
        }))
        .use(addPropertiesToCollectionItems('posts', post => {
          return Object.assign(post, {
            formattedDate: moment(post.date).format('MMMM DD')
          })
        }))
        .use(writemetadata({
          collections: {
            posts: {
              output: {
                path: 'blog/posts.json',
                asObject: true
              },
              ignorekeys: ['contents', 'next', 'previous', 'stats', 'mode', 'lunr']
            }
          }
        }))
        .use(tags({
          handle: 'category',
          path: 'blog/category/:tag.html',
          layout: '../layouts/blog-category.jade',
          sortBy: 'date',
          reverse: true
        }))
        .use(mlunr({
          indexPath: 'blog/search-index.json',
          fields: {
            contents: 2,
            title: 10,
            category: 5
          }
        }))
        .use(define({
          moment,
          rootUrl: CONFIG.root_url
        }))
        .use(feed({ collection: 'posts' }))
        .use(layouts({
          pattern: '**/*.html',
          engine: 'jade',
          directory: path.join('layouts')
        }))
        .use(reloadInMetalsmithPipeline)
  )
    .pipe(gulp.dest(paths.build))
})

gulp.task('build-site', () => {
  return gulp.src(['src/**/*.jade', 'src/*.md'])
    .pipe($.frontMatter().on('data', file => {
      Object.assign(file, file.frontMatter)
      delete file.frontMatter
    }))
    .pipe(
      gulpsmith()
        .use(addTimestampToMarkdownFiles)
        .use(markdown({
          smartypants: true,
          gfm: true,
          tables: true
        }))
        .use(jade({
          locals: { cssTimestamp, events: addDateProps(filterPastEvents(JSON.parse(fs.readFileSync('./src/events.json', 'utf8')))) },
          pretty: true
        }))
        .use(define({
          moment,
          rootUrl: CONFIG.root_url
        }))
        .use(each(updatePaths))
        .use(layouts({
          pattern: '**/*.html',
          engine: 'jade',
          directory: path.join('layouts')
        })))
    .use(reloadInMetalsmithPipeline)
    .pipe(gulp.dest(paths.build))
})

gulp.task('javascript', () => {
  return gulp.src(paths.js.src)
    .pipe($.babel({
      presets: ['es2015'],
      only: './src/scripts/**'
    }))
    .pipe($.concat('main.min.js'))
    .pipe($.if(isProd(), $.uglify()))
    .pipe(gulp.dest(paths.js.dest))
})

gulp.task('js-watch', ['javascript'], reload)

// TODO: minify in production
gulp.task('styles', () => {
  const processors = [
    autoprefixer({ browsers: ['last 3 versions'] })
  ]

  return gulp.src(paths.styles.src)
    .pipe($.sass({
      outputStyle: 'expanded',
      includePaths: [
        '/node_modules/',
        path.join(__dirname, 'node_modules/support-for/sass')
      ].concat(bourbon.includePaths)
    }).on('error', $.sass.logError))
    .pipe($.postcss(processors))
    .pipe($.if(isProd(), $.cleanCss()))
    .pipe(gulp.dest(paths.styles.dest))
    .pipe(browserSync.stream())
})

gulp.task('copy', () => {
  return gulp.src(paths.assets.src)
    .pipe(gulp.dest(paths.assets.dest))
})

// Utility functions

const isDev = () => process.env.NODE_ENV === 'development'
const isProd = () => process.env.NODE_ENV === 'production'

const reloadInMetalsmithPipeline = (a, b, done) => {
  reload()
  done()
}

function updatePaths (file, filename) {
  if (path.basename(filename) === 'index.html') { return filename }

  if (path.extname(filename) === '.html' && path.extname(filename) !== '') {
    return filename.split('.html')[0] + '/index.html'
  }
  return filename
}

function addPropertiesToCollectionItems (collectionName, callback) {
  return function (files, metalsmith, done) {
    let metadata = metalsmith.metadata()
    let collection = metadata[collectionName] || []

    metadata[collectionName] = collection.map(callback)

    return done()
  }
}

function addTimestampToMarkdownFiles (files, metalsmith, callback) {
  Object.keys(files).forEach(key => {
    if (key.split('.').pop() !== 'md') return
    Object.assign(files[key], { cssTimestamp })
  })
  callback()
}

const filterPastEvents = eventsArr => {
  const today = moment()
  return eventsArr.filter(event => moment(event.date).isAfter(today))
}

const addDateProps = eventsArr => {
  return eventsArr.map(event => {
    const date = moment(event.date)
    return Object.assign({}, event, {
      day: date.format('D'),
      month: date.format('MMM')
    })
  })
}
