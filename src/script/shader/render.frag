#define MARCH_ITER 200
#define RAYAMP_MIN 0.01
#define REFLECT_MAX 10.0
#define REFLECT_PER_PATH 2
#define INIT_LEN 0.005
#define FOG_LENGTH 0.1
#define FOG_THRESHOLD 0.001

// -----

#define MTL_AIR 1
#define MTL_FOG 2
#define MTL_SKY 3
#define MTL_FLOOR 4

// ------

#define PI 3.14159265
#define V vec2(0.,1.)
#define saturate(i) clamp(i,0.,1.)
#define lofi(i,m) (floor((i)/(m))*(m))

// ------

#extension GL_EXT_draw_buffers : require
precision highp float;

uniform float time;
uniform vec2 resolution;
uniform bool reset;

uniform sampler2D textureRandom;
uniform sampler2D textureRandomStatic;

uniform sampler2D textureDrawBuffers0;
uniform sampler2D textureDrawBuffers1;
uniform sampler2D textureDrawBuffers2;
uniform sampler2D textureDrawBuffers3;

// ------

vec4 seed;
float random() { // weird prng
  const vec4 q = vec4(   1225.0,    1585.0,    2457.0,    2098.0);
  const vec4 r = vec4(   1112.0,     367.0,      92.0,     265.0);
  const vec4 a = vec4(   3423.0,    2646.0,    1707.0,    1999.0);
  const vec4 m = vec4(4194287.0, 4194277.0, 4194191.0, 4194167.0);

  vec4 beta = floor(seed / q);
  vec4 p = a * (seed - beta * q) - beta * r;
  beta = (sign(-p) + vec4(1.0)) * vec4(0.5) * m;
  seed = (p + beta);

  return fract(dot(seed / m, vec4(1.0, -1.0, 1.0, -1.0)));
}

vec4 random4() {
  return vec4(
    random(),
    random(),
    random(),
    random()
  );
}

// ------

mat2 rotate2D( float _t ) {
  return mat2( cos( _t ), sin( _t ), -sin( _t ), cos( _t ) );
}

bool isUvValid( vec2 _v ) {
  return ( 0.0 <= _v.x ) && ( _v.x <= 1.0 ) && ( 0.0 <= _v.y ) && ( _v.y <= 1.0 );
}

float smin( float _a, float _b, float _k ) {
  float h = clamp( 0.5 + 0.5 * ( _b - _a ) / _k, 0.0, 1.0 );
  return mix( _b, _a, h ) - _k * h * ( 1.0 - h );
}

float smax( float _a, float _b, float _k ) {
  return -smin( -_a, -_b, _k );
}

vec4 noise( vec2 _uv ) {
  vec4 sum = V.xxxx;
  for ( int i = 0; i < 6; i ++ ) {
    float mul = pow( 2.0, float( i ) );
    sum += texture2D( textureRandomStatic, _uv / 64.0 * mul ) / 2.0 / mul;
  }
  return sum;
}

// ------

vec2 randomCircle() {
  vec2 v = V.xx;
  for ( int i = 0; i < 99; i ++ ) {
    v = random4().xy * 2.0 - 1.0;
    if ( length( v ) < 1.0 ) { break; }
  }
  return v;
}

vec3 randomSphere() {
  vec3 v = V.xxx;
  for ( int i = 0; i < 99; i ++ ) {
    v = random4().xyz * 2.0 - 1.0;
    if ( length( v ) < 1.0 ) { break; }
  }
  v = normalize( v );
  return v;
}

vec3 randomHemisphere( in vec3 _normal ) {
  vec3 v = randomSphere();
  if ( dot( v, _normal ) < 0.0 ) { v = -v; }
  return v;
}

// Ref: https://pathtracing.wordpress.com/2011/03/03/cosine-weighted-hemisphere/
vec3 randomHemisphereCosWeighted( in vec3 _normal ) {
  float theta = acos( sqrt( 1.0 - random() ) );
  float phi = 2.0 * PI * random();

  vec3 sid = (
    0.5 < abs( dot( V.xyx, _normal ) )
    ? normalize( cross( V.xxy, _normal ) )
    : normalize( cross( V.xyx, _normal ) )
  );
  vec3 top = normalize( cross( _normal, sid ) );

  return (
    sid * sin( theta ) * cos( phi )
    + top * sin( theta ) * sin( phi )
    + _normal * cos( theta )
  );
}

// ------

struct Camera {
  vec3 pos;
  vec3 dir;
  vec3 sid;
  vec3 top;
};

struct Ray {
  vec3 dir;
  vec3 ori;
  int mtl;
};

struct Map {
  float dist;
  int mtl;
  vec4 props;
};

struct March {
  Ray ray;
  Map map;
  float len;
  vec3 pos;
  vec3 normal;
  float edge;
};

struct Material {
  vec3 color;
  vec3 emissive;
  vec3 edgeEmissive;
  float reflective;
  float reflectiveRoughness;
  float refractive;
  float refractiveRoughness;
  float refractiveIndex;
};

// ------

Camera camInit( in vec3 _pos, in vec3 _tar ) {
  Camera cam;
  cam.pos = _pos;
  cam.dir = normalize( _tar - _pos );
  cam.sid = normalize( cross( cam.dir, V.xyx ) );
  cam.top = normalize( cross( cam.sid, cam.dir ) );

  return cam;
}

Ray rayInit( in vec3 _ori, in vec3 _dir, in int _mtl ) {
  Ray ray;
  ray.dir = _dir;
  ray.ori = _ori;
  ray.mtl = _mtl;
  return ray;
}

Ray rayFromCam( in vec2 _p, in Camera _cam ) {
  vec3 dir = normalize( _p.x * _cam.sid + _p.y * _cam.top + _cam.dir * 2.0 * ( 1.0 - length( _p.xy ) * 0.0 ) );
  return rayInit( _cam.pos, dir, 1 );
}

Map mapInit( in float _dist ) {
  Map map;
  map.dist = _dist;
  map.mtl = 1;
  return map;
}

March marchInit( in Ray _ray ) {
  March march;
  march.ray = _ray;
  march.len = INIT_LEN;
  march.pos = _ray.ori + _ray.dir * march.len;
  march.normal = V.xxy;
  march.edge = 0.0;
  return march;
}

Material mtlInit() {
  Material material;
  material.color = V.xxx;
  material.emissive = V.xxx;
  material.edgeEmissive = V.xxx;
  material.reflective = 0.0;
  material.reflectiveRoughness = 0.0;
  material.refractive = 0.0;
  material.refractiveRoughness = 0.0;
  material.refractiveIndex = 1.0;
  return material;
}

// ------

float sphere( in vec3 _p, in float _r ) {
  return length( _p ) - _r;
}

float box( in vec3 _p, in vec3 _size ) {
  vec3 d = abs( _p ) - _size;
  return min( max( d.x, max( d.y, d.z ) ), 0.0 ) + length( max( d, 0.0 ) );
}

Map distFunc( in vec3 _p, in int _mtl ) {
  Map map = mapInit( 1E9 );
  vec3 pp = _p;

  { // floor
    vec3 p = pp;
    float dist = p.y + 0.8;

    p -= vec3( -0.5, 0.0, 1.0 );
    p.xy = rotate2D( 0.6 ) * p.xy;
    p.zx = rotate2D( 0.6 ) * p.zx;
    dist = min( dist, box( p, vec3( 0.2, 1E9, 0.2 ) ) );

    if ( dist < map.dist ) {
      map = mapInit( dist );
      map.mtl = MTL_FLOOR;
    }
  }

  { // box
    vec3 p = pp - vec3( -2.0, 0.0, 3.0 );
    float timePhase = 0.5 - 0.5 * cos( time * PI );
    p.zx = rotate2D( -timePhase * PI / 2.0 ) * p.zx;

    float rotPhase = lofi( atan( p.z, p.x ), PI / 16.0 );
    p.zx = rotate2D( rotPhase + PI / 32.0 ) * p.zx;

    float phaseSum = rotPhase - timePhase * PI * 5.0 / 2.0;
    p -= vec3( 4.0, sin( phaseSum + PI / 2.0 ) * 0.4, 0.0 );
    p.xy = rotate2D( -phaseSum ) * p.xy;
    p.yz = rotate2D( -phaseSum ) * p.yz;

    float dist = box( p, vec3( 0.2 ) );

    if ( dist < map.dist ) {
      map = mapInit( dist );
      map.mtl = MTL_FLOOR;
    }
  }

  { // ita
    vec3 p = pp - vec3( 0.0, 0.0, -8.0 );
    p.yz = rotate2D( -0.7 ) * p.yz;
    p.zx = rotate2D( -0.7 ) * p.zx;

    float dist = abs( p.z ) - 0.1;
    float tri = abs( mod( p.x, 1.0 ) - 0.5 ) - 0.4;
    dist = max( dist, tri );

    if ( dist < map.dist ) {
      map = mapInit( dist );
      map.mtl = MTL_FLOOR;
    }
  }

  { // sky
    vec3 p = pp;
    float dist = -sphere( p, 30.0 );

    if ( dist < map.dist ) {
      map = mapInit( dist );
      map.mtl = MTL_SKY;
      map.props.x = 0.5 + 12.0 * pow( max( dot(
        normalize( p ),
        normalize( vec3( 1.0, 6.0, 3.0 ) )
      ), 0.0 ), 20.0 );
    }
  }

  return map;
}

vec3 normalFunc( in vec3 _p, in float _d, in int _mtl ) {
  vec2 d = V * _d;
  return normalize( vec3(
    distFunc( _p + d.yxx, _mtl ).dist - distFunc( _p - d.yxx, _mtl ).dist,
    distFunc( _p + d.xyx, _mtl ).dist - distFunc( _p - d.xyx, _mtl ).dist,
    distFunc( _p + d.xxy, _mtl ).dist - distFunc( _p - d.xxy, _mtl ).dist
  ) );
}

// ------

March march( in Ray _ray ) {
  Ray ray = _ray;
  March march = marchInit( ray );
  float fogLen = 0.0;
  bool fog = false;

  for ( int iMarch = 0; iMarch < MARCH_ITER; iMarch ++ ) {
    Map map = distFunc( march.pos, ray.mtl );
    map.dist *= 0.9;

    march.map = map;
    march.len += map.dist;
    march.pos = ray.ori + ray.dir * march.len;

    if ( ray.mtl == MTL_AIR ) {
      for ( int i = 0; i < 99; i ++ ) {
        if ( march.len < fogLen ) { break; }
        fogLen += random() * FOG_LENGTH;
        if ( random() < FOG_THRESHOLD ) {
          fog = true;
          break;
        }
      }
    }

    if ( fog || 1E3 < march.len || abs( map.dist ) < INIT_LEN * 0.01 ) { break; }
  }

  if ( fog ) {
    march.len = fogLen;
    march.pos = ray.ori + ray.dir * march.len;
    march.normal = randomHemisphere( -ray.dir );
    march.map.dist = 0.0;
    march.map.mtl = MTL_FOG;
  } else {
    march.normal = normalFunc( march.pos, 1E-4, ray.mtl );
    march.edge = 1.0 - smoothstep( 0.9, 0.98, dot( normalFunc( march.pos, 4E-4, ray.mtl ), march.normal ) );
  }

  return march;
}

// ------

Material getMtl( int _mtl, vec4 _props ) {
  Material mtl = mtlInit();

  if ( _mtl == MTL_AIR ) {
    mtl.color = vec3( 1.0 );
    mtl.refractive = 1.0;
    mtl.refractiveIndex = 1.0;

  } else if ( _mtl == MTL_SKY ) {
    mtl.emissive = vec3( 1.0 ) * _props.x;

  } else if ( _mtl == MTL_FOG ) {
    mtl.color = vec3( 0.7 );

  } else if ( _mtl == MTL_FLOOR ) {
    mtl.color = vec3( 0.9 );
    mtl.reflective = 0.1;

  }

  return mtl;
}

// ------

Ray shade( in March _march, inout vec3 colorAdd, inout vec3 colorMul ) {
  March march = _march;

  if ( abs( march.map.dist ) < 1E-2 ) {
    vec3 normal = march.normal;
    float edge = march.edge;

    int rayMtl = march.ray.mtl;
    Material material = getMtl( march.map.mtl, march.map.props );

    vec3 dir = V.xxx;
    float dice = random4().x;

    // colorAdd += colorMul * max( 0.0, dot( normal, -march.ray.dir ) ) * march.map.material.emissive;
    colorAdd += colorMul * material.emissive;
    colorAdd += colorMul * edge * material.edgeEmissive;

    colorMul *= material.color;
    if ( dice < material.reflective ) { // reflect
      vec3 ref = normalize( reflect(
        march.ray.dir,
        normal
      ) );
      vec3 dif = randomHemisphere( normal );
      dir = normalize( mix(
        ref,
        dif,
        material.reflectiveRoughness
      ) );
      colorMul *= max( dot( dir, ref ), 0.0 );

    } else if ( dice < material.reflective + material.refractive ) { // refract
      vec3 inc = normalize( march.ray.dir );
      float eta = getMtl( march.ray.mtl, V.xxxx ).refractiveIndex / material.refractiveIndex;

      vec3 ref = refract( inc, normal, eta );
      ref = ( ref == V.xxx )
      ? ( normalize( reflect(
        march.ray.dir,
        normal
      ) ) )
      : normalize( ref );

      vec3 dif = randomHemisphere( -normal );
      dir = normalize( mix(
        ref,
        dif,
        material.refractiveRoughness
      ) );
      colorMul *= max( dot( dir, ref ), 0.0 );

      rayMtl = march.map.mtl;

    } else { // diffuse
      dir = randomHemisphereCosWeighted( normal );
      colorMul *= 1.0;
    }

    Ray ray = rayInit( march.pos, dir, rayMtl );
    return ray;
  } else {
    colorMul *= 0.0;

    return rayInit( V.xxy, V.xxy, MTL_AIR );
  }
}

// ------

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  seed = texture2D( textureRandom, gl_FragCoord.xy / resolution );

  vec4 tex0 = texture2D( textureDrawBuffers0, uv );
  vec4 tex1 = texture2D( textureDrawBuffers1, uv );
  vec4 tex2 = texture2D( textureDrawBuffers2, uv );
  vec4 tex3 = texture2D( textureDrawBuffers3, uv );

  vec3 colorAdd = abs( tex1.xyz ) - 1E-2;
  vec3 colorMul = abs( tex2.xyz ) - 1E-2;
  vec3 colorOut = tex3.xyz;
  int rayMtl = int( abs( tex2.w ) );
  float depth = ( tex1.x < 0.0 ? 0.0 : 1.0 ) + ( tex1.y < 0.0 ? 0.0 : 2.0 ) + ( tex1.z < 0.0 ? 0.0 : 4.0 ) + ( tex2.x < 0.0 ? 0.0 : 8.0 ) + ( tex2.y < 0.0 ? 0.0 : 16.0 ) + ( tex2.z < 0.0 ? 0.0 : 32.0 );
  float samples = abs( tex3.w );

  Ray ray;
  vec3 dir = vec3( tex0.w, tex1.w, 0.0 );
  dir.z = sqrt( 1.0 - dot( dir, dir ) ) * sign( tex2.w );
  ray = rayInit( tex0.xyz, dir, rayMtl );

  if ( reset ) {
    colorOut = V.xxx;
    colorAdd = V.xxx;
    samples = 0.0;
  }

  for ( int i = 0; i < REFLECT_PER_PATH; i ++ ) {

    if ( reset || REFLECT_MAX <= depth || length( colorMul ) < RAYAMP_MIN ) {
      samples += 1.0;
      depth = 0.0;

      colorOut = mix(
        colorOut,
        max( V.xxx, colorAdd ),
        1.0 / samples
      );

      // ------

      vec3 camTar = vec3( 0.0, 0.0, 0.0 );
      Camera cam = camInit(
        vec3( 2.0, 1.0, 3.0 ),
        camTar
      );

      // dof
      vec2 dofCirc = randomCircle() * 0.01;
      cam.pos += dofCirc.x * cam.sid;
      cam.pos += dofCirc.y * cam.top;

      cam = camInit( cam.pos, camTar );

      // antialias
      vec2 pix = gl_FragCoord.xy + random4().xy - 0.5;

      vec2 p = ( pix * 2.0 - resolution ) / resolution.x;
      ray = rayFromCam( p, cam );

      colorAdd = V.xxx;
      colorMul = V.yyy;
    } else {
      depth += 1.0;
    }

    March m = march( ray );
    ray = shade( m, colorAdd, colorMul );

  }

  // ------

  vec3 depthBits1 = vec3(
    mod( depth, 2.0 ) < 1.0 ? -1.0 : 1.0,
    mod( depth / 2.0, 2.0 ) < 1.0 ? -1.0 : 1.0,
    mod( depth / 4.0, 2.0 ) < 1.0 ? -1.0 : 1.0
  );

  vec3 depthBits2 = vec3(
    mod( depth / 8.0, 2.0 ) < 1.0 ? -1.0 : 1.0,
    mod( depth / 16.0, 2.0 ) < 1.0 ? -1.0 : 1.0,
    mod( depth / 32.0, 2.0 ) < 1.0 ? -1.0 : 1.0
  );

  gl_FragData[ 0 ] = vec4( ray.ori, ray.dir.x );
  gl_FragData[ 1 ] = vec4( ( colorAdd + 1E-2 ) * depthBits1, ray.dir.y );
  gl_FragData[ 2 ] = vec4( ( colorMul + 1E-2 ) * depthBits2, float( ray.mtl ) * ( ( 0.0 < ray.dir.z ) ? 1.0 : -1.0 ) );
  gl_FragData[ 3 ] = vec4( colorOut, samples );
}
