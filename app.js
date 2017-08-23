'use strict';
var Couchbase = require("couchbase");
var Express = require("express");
var Cors = require("cors");
var UUID = require("uuid");
var BodyParser = require("body-parser");
var Bcrypt = require("bcryptjs");

var app = Express();
var N1qlQuery = Couchbase.N1qlQuery;

app.use(Cors());
app.use(BodyParser.json());
app.use(BodyParser.urlencoded({
  extended: true
}));

var cluster = {};
var bucket = {};
var bearerToken = "";

var queryDB = {};

app.post("/account", (request, response) => {
  if (!request.body.email) {
    return response.status(401).send({
      "message": "An `email` is required"
    });
  } else if (!request.body.password) {
    return response.status(401).send({
      "message": "A `password` is required"
    });
  }
  var id = UUID.v4();
  var account = {
    "type": "account",
    "pid": id,
    "email": request.body.email,
    "password": Bcrypt.hashSync(request.body.password, 10)
  };
  var profile = request.body;
  profile.type = "profile";
  delete profile.password;
  bucket.insert(id, profile, (error, result) => {
    if (error) {
      return response.status(500).send(error);
    }
    bucket.insert(request.body.email, account, (error, result) => {
      if (error) {
        bucket.remove(id);
        return response.status(500).send(error);
      }
      response.send(result);
    });
  });
});

app.post("/login", (request, response) => {
  if (!request.body.email) {
    return response.status(401).send({
      "message": "An `email` is required"
    });
  } else if (!request.body.password) {
    return response.status(401).send({
      "message": "A `password` is required"
    });
  }
  bucket.get(request.body.email, (error, result) => {
    if (error) {
      return response.status(500).send(error);
    }
    if (!Bcrypt.compareSync(request.body.password, result.value.password)) {
      return response.status(500).send({
        "message": "The password is invalid"
      });
    }
    var session = {
      "type": "session",
      "id": UUID.v4(),
      "pid": result.value.pid
    };
    bucket.get(session.pid, (error, res) => {
      if (error) {
        return response.status(500).send("Error retrying Name " + error);
      }
      //console.log(res)
      session.display_name = res.value.firstname + " " + res.value.lastname;
      bucket.insert(session.id, session, {
        "expiry": 3600
      }, (error, result) => {
        if (error) {
          return response.status(500).send(error);
        }
        response.send({
          "sid": session.id,
          "pid": session.pid,
          "display_name": session.display_name,
          "email": request.body.email
        });
      });
    });
  });
});

var validate = function (request, response, next) {
  var authHeader = request.headers["authorization"];
  if (authHeader) {
    //console.log("Auth: ", authHeader);
    bearerToken = authHeader.split(" ");
    if (bearerToken.length == 2) {
      bucket.get(bearerToken[1], (error, result) => {
        if (error) {
          return response.status(401).send({
            "message": "Invalid session token"
          });
        }
        request.pid = result.value.pid;
        bucket.touch(bearerToken[1], 3600, (error, result) => {});
        next();
      });
    }
  } else {
    response.status(401).send({
      "message": "An authorization header is required"
    });
  }
};

app.get("/account", validate, (request, response) => {
  bucket.get(request.pid, (error, result) => {
    if (error) {
      return response.status(500).send(error);
    }
    response.send(result.value);
  });
});

app.post("/blog", validate, (request, response) => {
  if (!request.body.title) {
    return response.status(401).send({
      "message": "A `title` is required"
    });
  } else if (!request.body.content) {
    return response.status(401).send({
      "message": "A `content` is required"
    });
  }
  var blog = request.body;
  blog.type = "blog", blog.pid = request.pid, blog.timestamp = (new Date()).getTime();
  var id = blog.id || UUID.v4();
  delete blog.id;
  bucket.upsert(id, blog, (error, result) => {
    if (error) {
      return response.status(500).send(error);
    }
    response.send(blog);
  });
});

app.post("/delete", validate, (request, response) => {
  if (!request.body.pid) {
    return response.status(401).send({
      "message": "doc key is missing"
    });
  }
  if (!['blog', 'account'].includes(request.body.type)) {
    return response.status(401).send({
      "message": "Actually you can delete blog or total account only...."
    });
  }
  bucket.remove(request.body.pid, (error, result) => {
    if (error && error.code !== 13) {
      return response.status(500).send(error);
    }
    if (request.body.type === 'account') {
      var query = N1qlQuery.fromString("DELETE FROM `" + bucket._name + "` WHERE pid = $pid ");
      query.consistency(N1qlQuery.Consistency.REQUEST_PLUS);
      //console.log(query);
      bucket.query(query, {
        "pid": request.body.pid
      }, (error, result) => {
        if (error) {
          return response.status(500).send(error);
        }
      });
    }
    response.send(result);
  });
});

app.get("/blogs", validate, (request, response) => {
  console.log(request.pid);
  var query = N1qlQuery.fromString("SELECT `" + bucket._name + "`.*, meta().id FROM `" + bucket._name + "` WHERE type = 'blog' AND pid = $pid order by meta().cas desc");
  query.consistency(N1qlQuery.Consistency.REQUEST_PLUS);
  //console.log(query);
  bucket.query(query, {
    "pid": request.pid
  }, (error, result) => {
    if (error) {
      return response.status(500).send(error);
    }
    response.send(result);
  });
});

app.get("/query/:type", (request, response) => {
  //var query = N1qlQuery.fromString(queryDB[request.params.type]);
  var query = N1qlQuery.fromString(queryDB.find(x => x.id === request.params.type).sql);
  bucket.query(query, (error, result) => {
    if (error) {
      return response.status(500).send(error);
    }
    //console.log(result);
    response.send(result);
  });
});

app.get("/setdb/:host", (request, response) => {
  cluster = new Couchbase.Cluster("couchbase://" + request.params.host);
  bucket = cluster.openBucket("default", "");

  var query = N1qlQuery.fromString("select id, description, sql from default where type ='query' order by id");
  bucket.query(query, (error, result) => {
    if (error) {
      return response.status(500).send(error);
    }
    queryDB = result;
    response.send("Db ready, found " + queryDB.length + " 'query' type docs.");
  });
});

app.get("/", (request, response) => {

  response.send("Use /setdb/<your-host-ip-address> to set the db host");

});


/*
var server = app.listen(3000, () => {
  console.log("Listening on port " + server.address().port + "...");
});
*/
// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});
