/*
 * This file is part of gorilla-repl. Copyright (C) 2014-, Jony Hudson.
 *
 * gorilla-repl is licenced to you under the MIT licence. See the file LICENCE.txt for full details.
 */

// A websocket connection to the repl. Works with `gorilla-repl.websocket-relay` on the backend.
// This code also keeps track of running evaluations and dispatches responses to the appropriate worksheet segments.

var repl = (function () {

    var self = {};

    // This is exposed to make it easy to test direct interaction with the nREPL server from the dev tools. It
    // shouldn't be considered part of the public API
    self.sendREPLCommand = function (message) {
        self.ws.send(JSON.stringify(message));
    };

    // Connect to the websocket nREPL bridge.
    // TODO: handle errors.
    self.connect = function (successCallback, failureCallback) {
        // hard to believe we have to do this
        var loc = window.location;
        var url = "ws://" + loc.hostname + ":" + loc.port + "/repl";
        self.ws = new WebSocket(url);

        // we first install a handler that will capture the session id from the clone message. Once it's done its work
        // it will replace the handler with one that handles the rest of the messages, and call the successCallback.
        self.ws.onmessage = function (message) {
            var msg = JSON.parse(message.data);
            if (msg['new-session']) {
                self.sessionID = msg['new-session'];
                self.ws.onmessage = handleMessage;
                successCallback();
            }
        };

        // The first thing we do is send a clone op, to get a new session.
        self.ws.onopen = function () {
            self.ws.send(JSON.stringify({"op": "clone"}));
        };

        // If the websocket connection dies we're done for, message the app to tell it so.
        self.ws.onclose = function () {
            eventBus.trigger("app:connection-lost");
        };
    };

    // This maps evaluation IDs to the IDs of the segment that initiated them.
    var evaluationMap = {};

    // tracks the namespace that the last evaluation completed in
    self.currentNamespace = "user";

    // The public interface for executing code on the REPL server.
    eventBus.on("evaluator:evaluate", function (e, d) {
        // generate an ID to tie the evaluation to its results - when responses are received, we route them to the
        // originating segment for display using this ID (see the repl:response event handler below).
        var id = UUID.generate();
        // store the evaluation ID and the segment ID in the evaluationMap
        evaluationMap[id] = d.segmentID;
        var message = {'op': 'eval', 'code': d.code, id: id, session: self.sessionID};
        self.sendREPLCommand(message);
    });

    // as well as eval messages, we also send "service" messages to the nREPL server for things like autocomplete,
    // docs etc. We maintain a separate map which maps the ID of the service message to the callback function that
    // we'd like to run on the returned data.
    var serviceMessageMap = {};

    // send a service message, and schedule the given callback to run on completion. An ID and the session information
    // will be added to the message,
    var sendServiceMessage = function (msg, callback) {
        var id = UUID.generate();
        serviceMessageMap[id] = callback;
        msg.id = id;
        msg.session = self.sessionID;
        self.sendREPLCommand(msg);
    };

    // query the REPL server for autocompletion suggestions. Relies on the cider-nrepl middleware.
    // We call the given callback with the list of symbols once the REPL server replies.
    self.getCompletions = function (symbol, ns, context, callback) {
        sendServiceMessage({op: "complete", symbol: symbol, ns: ns}, function (d) {
            callback(d.value);
        });
    };

    // handle the various different nREPL responses
    var handleMessage = function (message) {
        var d = JSON.parse(message.data);

        // Is this a message relating to an evaluation triggered by the user?
        var segID = evaluationMap[d.id];
        if (segID != null) {

            // - evaluation result (Hopefully no other responses have an ns component!)
            if (d.ns) {
                self.currentNamespace = d.ns;
                eventBus.trigger("evaluator:value-response", {ns: d.ns, value: d.value, segmentID: segID});
                return;
            }

            // - console output
            if (d.out) {
                eventBus.trigger("evaluator:console-response", {out: d.out, segmentID: segID});
                return;
            }

            // - status response
            if (d.status) {
                // is this an evaluation done message
                if (d.status.indexOf("done") >= 0) {
                    eventBus.trigger("evaluator:done-response", {segmentID: segID});
                    // keep the evaluation map clean
                    delete evaluationMap[d.id];
                    return;
                }
            }

            // - error message
            if (d.err) {
                eventBus.trigger("evaluator:error-response", {error: d.err, segmentID: segID});
                return;
            }

            // - root-ex message
            if (d['root-ex']) {
                // at the minute we just eat (and log) these - I'm not really sure what they're for!
                console.log("Root-ex message: " + JSON.stringify(d));
                return;
            }
        }

        // If this reply isn't associated with a segment, then it's probably a reply to a service message
        if (serviceMessageMap[d.id]) {
            // if it's a status "done" message, clean up the service map
            if (d.status) {
                if (d.status.indexOf("done") >= 0) {
                    delete serviceMessageMap[d.id];
                    return;
                }
            }
            // otherwise, get the callback from the service map and run it
            serviceMessageMap[d.id](d);
            return;
        }


        // If we get here, then we don't know what the message was for - just log it
        console.log("Unknown response: " + JSON.stringify(d));
    };


    return self;
})();