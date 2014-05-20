//
// EBS volume migration between instances
//
// Vlad Seryakov 2014, vseryakov@gmail.com
//

var util = require("util");
var async = require("async");
var ec2 = require('aws2js').load('ec2');

var key,
    secret,
    instanceId,
    region = 'us-east-1',
    typeId = "m1.large",
    debug = 0,
    show = 0,
    device = "/dev/sda1",
    timeout = 300000;

for (var i = 1; i < process.argv.length; i++) {
    if (process.argv[i] == "-debug") debug = 1; else
    if (process.argv[i] == "-show") show = 1; else
    if (process.argv[i] == "-device") device = process.argv[++i]; else
    if (process.argv[i] == "-timeout") timeout = parseInt(process.argv[++i]); else
    if (process.argv[i] == "-key") key = process.argv[++i]; else
    if (process.argv[i] == "-secret") secret = process.argv[++i]; else
    if (process.argv[i] == "-region") region = process.argv[++i]; else
    if (process.argv[i] == "-instance") instanceId = process.argv[++i]; else
    if (process.argv[i] == "-type") typeId = process.argv[++i]; else
    if (process.argv[i] == "-help") {
        console.log("Usage:\n\t", process.argv[0], "[-instance id] [-type T] [-show] [-debug] [-device D] [-region R] [-key K] [-secret S] [-timeout T]")
        process.exit(1);
    }
}

ec2.setCredentials(key || process.env.AWS_ACCESS_KEY_ID, secret ||  process.env.AWS_SECRET_ACCESS_KEY);
ec2.setRegion(region);

// Return a property from the complex object
function getValue(obj, name, asList)
{
    if (!obj) return null;
    name = name.split(".");
    for (var i = 0; i < name.length; i++) {
        obj = obj[name[i]];
        if (typeof obj == "undefined") return null;
    }
    if (obj && asList && !Array.isArray(obj)) obj = [ obj ];
    return obj;
}

// Find the volume in the instance object
function getVolume(obj, name)
{
    var volumes = getValue(obj, "blockDeviceMapping.item");
    return !Array.isArray(volumes) ? volumes : volumes.filter(function(x) { return x.deviceName == name && x.ebs.volumeId }).pop();
}

// Poll the AWS API command until the status is ready or timeout happens
function waitForStatus(cmd, filter, id, item, status, callback)
{
    var rc = "", started = Date.now(), response;

    async.doUntil(function(next) {
        request(cmd, { 'Filter.1.Name': filter, 'Filter.1.Value.1': id }, function(err, res) {
            if (err) return next(err);
            response = res;
            rc = getValue(res, item);
            setTimeout(next, rc == status ? 0 : 5000);
        });
    },
    function() {
        console.log("STATUS:", id, rc);
        return rc == status || Date.now() - started > timeout;
    },
    function(err) {
        if (err) return callback(err);
        if (rc != status) err = new Error("timeout waiting for " + filter + " " + id + " with status " + status);
        callback(err, response);
    });
}

// Wraper around API call with debugging and error reporting
function request(cmd, params, next)
{
    console.log('REQUEST:', cmd, util.inspect(params).replace(/[\r\n\t]/g, ""));
    ec2.request(cmd, params, function(err, res) {
        if (debug || err) console.log("DEBUG:", cmd, params, "error:", util.inspect(err, { depth: null }), "res:", util.inspect(res, { depth: null }));
        next(err, res);
    });
}

// Our instances and volumes to be collected
var instance, instance2, volume, volume2;

// The sequence of migration
async.series([
    function(next) {
        var params = instanceId ? { 'Filter.1.Name': 'instance-id', 'Filter.1.Value.1': instanceId } : {};
        request('DescribeInstances', params, function(err, res) {
            if (show || !instanceId) {
                console.log(util.inspect(res, { depth: null }));
                process.exit(0);
            }
            instance = getValue(res, "reservationSet.item.instancesSet.item");
            if (!instance) return next(new Error("instance " + instanceId + " not found"));
            next();
        })
    },
    function(next) {
        // Find out for sure about Elastic IP, not just use public address
        request("DescribeAddresses", { 'Filter.1.Name': 'instance-id', 'Filter.1.Value.1': instanceId }, function(err, res) {
            instance.elasticIp = getValue(res, "addressesSet.item.publicIp");
            next(err);
        });
    },
    function(next) {
        volume = getVolume(instance, device);
        if (!volume) return next(new Error("no EBS volume " + device + " found in instance " + instanceId));
        request("ModifyInstanceAttribute", { "InstanceId": instance.instanceId, "BlockDeviceMapping.1.DeviceName": device, "BlockDeviceMapping.1.Ebs.DeleteOnTermination": false }, next);
    },
    function(next) {
        request("StopInstances", { "InstanceId.1": instance.instanceId }, next);
    },
    function(next) {
        waitForStatus("DescribeInstances", 'instance-id', instance.instanceId, "reservationSet.item.instancesSet.item.instanceState.name", "stopped", next);
    },
    function(next) {
        request("DetachVolume", { VolumeId: volume.ebs.volumeId }, next);
    },
    function(next) {
        waitForStatus("DescribeVolumes", "volume-id", volume.ebs.volumeId, "volumeSet.item.status", "available", next);
    },
    function(next) {
        // Run new instance with all the same parameters as the old one
        var params = { MinCount: 1, MaxCount: 1, InstanceType: typeId, ImageId: instance.imageId, "Placement.AvailabilityZone": instance.placement.availabilityZone };
        if (instance.keyName) params.KeyName = instance.keyName;
        if (instance.ebsOptimized) params.EbsOptimized = instance.ebsOptimized;
        if (instance.iamInstanceProfile) params['IamInstanceProfile.Name'] = instance.iamInstanceProfile.id;
        if (instance.subnetId) params.SubnetId = instance.subnetId;
        var groups = getValue(instance, "groupSet.item", true);
        if (groups) groups.forEach(function(x, i) { params['SecurityGroupId.' + i] = x.groupId });
        request("RunInstances", params, function(err, res) {
            instance2 = getValue(res, "instancesSet.item");
            next(err);
        });
    },
    function(next) {
        // Move tags from the old instance
        var params = { "ResourceId.1": instance2.instanceId };
        var tags = getValue(instance, "tagSet.item", true);
        if (!tags) return next();
        tags.forEach(function(x, i) {
            params["Tag." + i + ".Key"] = x.key;
            params["Tag." + i + ".Value"] = x.value;
        });
        // Ignore errors here, tag are not important to fail the whole sequence
        request("CreateTags", params, function() { next(); });
    },
    function(next) {
        // Have to get the volume once the instance is up because device mapping is not available just after the launch
        waitForStatus("DescribeInstances", 'instance-id', instance2.instanceId, "reservationSet.item.instancesSet.item.instanceState.name", "running", function(err, res) {
            volume2 = getVolume(getValue(res, "reservationSet.item.instancesSet.item"), device);
            next(!volume2 ? new Error("no EBS volume in instance " + instance2.instanceId) : null);
        });
    },
    function(next) {
        // Stop new instance to re-attach our EBS drive
        request("StopInstances", { "InstanceId.1": instance2.instanceId }, next);
    },
    function(next) {
        waitForStatus("DescribeInstances", 'instance-id', instance2.instanceId, "reservationSet.item.instancesSet.item.instanceState.name", "stopped", next);
    },
    function(next) {
        request("DetachVolume", { VolumeId: volume2.ebs.volumeId }, next);
    },
    function(next) {
        waitForStatus("DescribeVolumes", "volume-id", volume2.ebs.volumeId, "volumeSet.item.status", "available", next);
    },
    function(next) {
        // No need for the old disk and extra space dangling around
        request("DeleteVolume", { VolumeId: volume2.ebs.volumeId }, next);
    },
    function(next) {
        request("AttachVolume", { VolumeId: volume.ebs.volumeId, InstanceId: instance2.instanceId, Device: device }, next);
    },
    function(next) {
        waitForStatus("DescribeVolumes", "volume-id", volume.ebs.volumeId, "volumeSet.item.status", "in-use", next);
    },
    function(next) {
        // Make sure our EBS disk is never terminated
        request("ModifyInstanceAttribute", { "InstanceId": instance2.instanceId, "BlockDeviceMapping.1.DeviceName": device, "BlockDeviceMapping.1.Ebs.DeleteOnTermination": false }, next);
    },
    function(next) {
        request("StartInstances", { "InstanceId.1": instance2.instanceId }, next);
    },
    function(next) {
        waitForStatus("DescribeInstances", 'instance-id', instance2.instanceId, "reservationSet.item.instancesSet.item.instanceState.name", "running", next);
    },
    function(next) {
        // Associate with the same Elastic IP, ignore errors as well, it can be associated once the instance is up
        if (!instance.elasticIp) return next();
        var params = { PublicIp: instance.elasticIp, InstanceId: instance2.instanceId };
        if (instance.subnetId) params.AllowReassociation = true;
        request("AssociateAddress", params, function() { next(); });
    },
    ], function(err) {
        if (err) return console.log("ERROR:", util.inspect(err, { depth: null }));
        console.log("DONE:", instance2.instanceId);
});
